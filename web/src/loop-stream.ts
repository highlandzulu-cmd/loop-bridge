/**
 * Custom pi-agent-core `StreamFn` that routes LLM calls to the Rust `loop-server`
 * bridge instead of calling a provider directly. Loop's `AgentHarness` does all
 * the real work (model call, tool execution, session memory) server-side; this
 * file's only job is translating between the two wire formats.
 *
 * IMPORTANT: Loop's SSE stream is `AgentEvent`, not `AssistantMessageEvent`.
 * Verified live against the real server: Loop's own agent_loop.rs deliberately
 * reshapes the LLM stream's `start` into `AgentEvent::MessageStart` and its
 * `done`/`error` into `AgentEvent::MessageEnd` — those tags never pass through
 * to the wire as themselves. Only the delta-producing middle events
 * (text_start/delta/end, thinking_*, toolcall_*) are forwarded as-is inside
 * `AgentEvent::MessageUpdate`. This file re-synthesizes `start`/`done`/`error`
 * from `message_start`/`message_end` so pi-agent-core sees a normal, complete
 * AssistantMessageEvent lifecycle.
 *
 * The nested AssistantMessage/ToolCall/Usage payloads are already camelCase on
 * the wire (Loop's Rust structs deliberately mirror pi-ai's field names) — no
 * renaming needed there. The only snake_case→camelCase rename needed is on the
 * event envelope itself: `content_index`→`contentIndex`, `tool_call`→`toolCall`.
 *
 * TOOL USE: if a turn involves tool use, Loop's harness runs the full
 * model-call → tool-execution → model-call cycle server-side and emits more
 * than one message_start/message_end pair within a single /prompt response
 * — one per round, each its own AgentEvent turn_start/turn_end, all inside
 * one agent_start/agent_end. The intermediate message_end has
 * stopReason "toolUse"; only the last round's message_end is the real end
 * of the turn. Verified live: surfacing that intermediate one as "done"
 * makes pi-agent-core's Agent think *it* owns tool execution (its `tools`
 * array here is empty — see main.ts) — it then fails to find the tool
 * ("Tool bash not found") and fires a follow-up request while loop-server
 * is still mid-turn, which loop-server correctly 409s. So: only the first
 * assistant message_start becomes a `start`, and only a message_end whose
 * stopReason isn't "toolUse" becomes a `done`/`error` — intermediate rounds
 * are dropped and folded into the one open message instead (see
 * `accumulatedContent` below).
 *
 * SHOWING THE TOOL CALL ITSELF: verified by reading pi-agent-core's own
 * streamAssistantResponse (agent-loop.js) — its accumulator does
 * `partialMessage = event.partial` on every text/thinking/toolcall event,
 * a full replace, not an append, and only finalizes on the one "done" it's
 * allowed to see. So each intermediate round's finished content (typically
 * just its toolCall block) has to be manually carried forward and prefixed
 * onto every subsequent event's `partial.content` — otherwise it just gets
 * overwritten the moment the next round's own text starts streaming in.
 * That's what `accumulatedContent` + `withAccumulated` do below, and it's
 * why toolcall_* is no longer excluded from the forwarded event types.
 *
 * WHAT THIS STILL CAN'T DO: show the tool's actual *result* as its own
 * message bubble the way native pi-agent-core tool execution would.
 * `ToolResultMessage` (role: "toolResult") is a wholly separate message
 * type from `AssistantMessage` in pi-ai's type system — there's no content
 * block for it, and a `StreamFn` (this file's whole contract) can only
 * describe one assistant message stream. It has no channel to inject a
 * second, separate message into `context.messages`. Real parity there
 * would mean reaching into `agent.state.messages` directly from main.ts
 * (outside the StreamFn contract entirely) after each /prompt call — a
 * bigger, more invasive change, not done here.
 *
 * REGRESSION FOUND AND FIXED WHILE BUILDING THIS: the first version of this
 * merged accumulated content — toolCall included — straight into the
 * *final* `done` message too. Verified live this breaks things: runLoop's
 * `toolCalls = message.content.filter(c => c.type === "toolCall")` check
 * (agent-loop.js) runs unconditionally, regardless of `stopReason` — so a
 * "done"/stop message that still contains a toolCall block makes
 * pi-agent-core try to execute it anyway, fail (empty `tools`, same "Tool
 * bash not found" as before), inject a real toolResult message saying so,
 * and then fire a *second*, bogus loop-server request with empty text
 * (the last message is no longer role "user" once that toolResult lands,
 * so extractPromptText() below returns ""). Caught by inspecting
 * `session.state.messages` live after a send — a fake toolResult and a
 * hallucinated second assistant reply were both sitting right there.
 * Fix: toolCall blocks are only ever included in the *streaming*
 * (message_update) view for transient visibility while the tool is
 * running — filterFinal() strips them back out before the true `done`, so
 * the finalized message pi-agent-core actually keeps is clean text only.
 * The tool call is visible while it runs, then folds away once the turn
 * completes — a real limit of this StreamFn-based approach (see the
 * previous note), not a bug left unfixed.
 */
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	type Api, type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";

function renameKeys(raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...raw };
	if ("content_index" in out) {
		out.contentIndex = out.content_index;
		delete out.content_index;
	}
	if ("tool_call" in out) {
		out.toolCall = out.tool_call;
		delete out.tool_call;
	}
	return out;
}

/**
 * Prefix `accumulated` (finished earlier rounds' content blocks, e.g. a
 * completed toolCall) onto this event's own `partial.content`. Needed
 * because pi-agent-core's accumulator replaces its whole partial message on
 * every event rather than merging — see the file header's "SHOWING THE
 * TOOL CALL ITSELF" note for why forwarding events as-is would just lose
 * earlier rounds' content the moment the next round starts streaming.
 */
/**
 * Content safe to keep in the *finalized* message: everything except
 * toolCall blocks. A finished toolCall left in a "done" message's content
 * makes pi-agent-core try to execute it (see file header's "REGRESSION
 * FOUND AND FIXED" note) — those are only ever safe to show transiently,
 * during message_update.
 */
function filterFinal(content: AssistantMessage["content"]): AssistantMessage["content"] {
	return content.filter((block) => block.type !== "toolCall");
}

function withAccumulated(
	raw: Record<string, unknown>,
	accumulated: AssistantMessage["content"],
): Record<string, unknown> {
	if (accumulated.length === 0) return raw;
	const partial = raw.partial as { content?: unknown[] } | undefined;
	if (!partial) return raw;
	return { ...raw, partial: { ...partial, content: [...accumulated, ...(partial.content ?? [])] } };
}

function extractPromptText(context: Context): string {
	const last = context.messages[context.messages.length - 1];
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}

function errorMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: text,
		timestamp: Date.now(),
	};
}

export interface LoopStreamFnOptions {
	/** Base URL of the loop-server bridge, e.g. "http://127.0.0.1:8787". */
	baseUrl: string;
}

/**
 * Builds a complete `AssistantMessage` — the type requires every field
 * (usage, stopReason, timestamp, ...) even for a synthetic message that
 * never touched a real model, so `/rag-query` and `/rag-add` below
 * (which bypass the model/harness entirely) still need a fully-formed one
 * to satisfy the `start`/`done`/`error` event shapes.
 */
function assistantMessage(model: Model<Api>, content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * Visually tags the chat bubble a /rag-* command's result just rendered
 * into, so it reads as a direct tool result rather than a normal model
 * reply — the highlighting the user asked for ("like Claude").
 *
 * Deliberately NOT done by giving the synthesized message a real `toolCall`
 * content block (which would reuse pi-web-ui's own native tool-call card —
 * nicer, but a hard no: this file's header already documents, from a real
 * regression hit while building the basic /rag-query support, that a
 * "done" message containing a toolCall block makes pi-agent-core try to
 * execute it itself, fail, and fire a bogus follow-up request. Achieving a
 * real toolResult pairing would mean mutating `agent.state.messages`
 * directly from outside the StreamFn entirely — a bigger, separately-risky
 * change the same header calls out as not worth it here).
 *
 * Instead: after the synthesized "done" event is pushed, find the
 * `<assistant-message>` element it just became (light DOM, confirmed live
 * — pi-web-ui overrides Lit's createRenderRoot() on every component in
 * this tree) and tag it directly with a CSS class + a label attribute for
 * app.css to style. Safe specifically because nothing else runs
 * concurrently with a /rag-* command (no real model turn in flight), so
 * "the last <assistant-message> in the DOM right now" is unambiguously
 * this one — a double requestAnimationFrame gives Lit's async render a
 * moment to actually add it first.
 */
function tagLastAssistantMessageAsToolResult(label: string) {
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			const nodes = document.querySelectorAll("assistant-message");
			const last = nodes[nodes.length - 1];
			if (last) {
				last.classList.add("pw-tool-result");
				last.setAttribute("data-tool-label", label);
			}
		});
	});
}

// Matches "/rag-query <question>" or "/rag-add <path>" as the entire typed
// message (not just a prefix elsewhere in the text) — [\s\S]+ instead of .+
// so a pasted multi-line question/path still matches.
const RAG_QUERY_COMMAND = /^\/rag-query\s+([\s\S]+)$/;
const RAG_ADD_COMMAND = /^\/rag-add\s+([\s\S]+)$/;
const RAG_LIST_COMMAND = /^\/rag-list\s*$/;
const RAG_GET_COMMAND = /^\/rag-get\s+([\s\S]+)$/;

/** Build a pi-agent-core StreamFn backed by a running loop-server instance. */
export function createLoopStreamFn(opts: LoopStreamFnOptions) {
	return function loopStreamFn(model: Model<Api>, context: Context, _options?: SimpleStreamOptions) {
		const stream = createAssistantMessageEventStream();

		(async () => {
			try {
				const promptText = extractPromptText(context);

				// /rag-query and /rag-add are a manual, deterministic shortcut to
				// loop-server's direct /rag/query and /rag/ingest endpoints — no
				// LLM turn involved at all, unlike the rag_query/read_document
				// *tools* the model can already choose to call on its own mid-
				// conversation. Handled here (rather than as real chat messages
				// sent through /prompt) because this is the only seam available
				// to intercept before pi-web-ui's ChatPanel hands the message to
				// pi-agent-core — see this file's header for why.
				//
				// Matched against a *trimmed* copy, not promptText directly: hit
				// live during testing — a stray leading space (from a Backspace
				// that silently didn't register, but just as easily a real user
				// fat-fingering a space before "/") made "^\/rag-get" fail to
				// match, silently falling through to a real, wasted LLM turn
				// instead of the intended direct command. Trimming a real chat
				// message before sending is harmless either way.
				const trimmedPromptText = promptText.trim();
				const queryMatch = trimmedPromptText.match(RAG_QUERY_COMMAND);
				const addMatch = trimmedPromptText.match(RAG_ADD_COMMAND);
				const listMatch = trimmedPromptText.match(RAG_LIST_COMMAND);
				const getMatch = trimmedPromptText.match(RAG_GET_COMMAND);
				if (queryMatch || addMatch || listMatch || getMatch) {
					stream.push({ type: "start", partial: assistantMessage(model, [], "stop") });
					try {
						if (queryMatch) {
							const res = await fetch(`${opts.baseUrl}/rag/query`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ query: queryMatch[1] }),
							});
							const body = await res.json();
							if (!res.ok) {
								throw new Error(body?.error ?? `RAG query failed (HTTP ${res.status})`);
							}
							const sources = Array.isArray(body.matches)
								? body.matches.map((m: { score?: number }, i: number) => `[${i + 1}] score ${m.score?.toFixed(2) ?? "?"}`).join(", ")
								: "";
							const text = `${body.answer ?? JSON.stringify(body)}${sources ? `\n\nSources: ${sources}` : ""}`;
							stream.push({ type: "done", reason: "stop", message: assistantMessage(model, [{ type: "text", text }], "stop") });
							tagLastAssistantMessageAsToolResult("rag-query");
						} else if (addMatch) {
							const path = addMatch[1].trim();
							const res = await fetch(`${opts.baseUrl}/rag/ingest`, {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ path }),
							});
							const body = await res.json();
							if (!res.ok) {
								throw new Error(body?.error ?? `RAG ingest failed (HTTP ${res.status})`);
							}
							// doc_id/chunks_stored render nicest but aren't a fixed spec (see
							// crates/loop-server/README.md "Swapping in a RAG service") — the
							// configured RAG service's /ingest may omit them, so this falls
							// back to the raw response rather than printing "undefined".
							const text =
								typeof body.doc_id === "string" && typeof body.chunks_stored === "number"
									? `Ingested \`${path}\` as \`${body.doc_id}\` (${body.chunks_stored} chunk${body.chunks_stored === 1 ? "" : "s"}).`
									: `Ingested \`${path}\`. Response: ${JSON.stringify(body)}`;
							stream.push({ type: "done", reason: "stop", message: assistantMessage(model, [{ type: "text", text }], "stop") });
							tagLastAssistantMessageAsToolResult("rag-add");
						} else if (listMatch) {
							// /rag/documents isn't part of the fixed RAG interface contract
							// (crates/loop-server/README.md "Swapping in a RAG service") —
							// most vector databases have no native "list everything" API, so
							// this degrades to raw JSON if the configured service's response
							// doesn't look like { documents: [...] }.
							const res = await fetch(`${opts.baseUrl}/rag/documents`);
							const body = await res.json();
							if (!res.ok) {
								throw new Error(body?.error ?? `RAG document list failed (HTTP ${res.status})`);
							}
							const text = Array.isArray(body.documents)
								? body.documents.length === 0
									? "No documents have been ingested yet. Use /rag-add <path> to add one."
									: body.documents
											.map((d: { doc_id?: string; chunks_stored?: number; ingested_at?: string }) => `- \`${d.doc_id}\` — ${d.chunks_stored} chunk${d.chunks_stored === 1 ? "" : "s"}, ingested ${d.ingested_at}`)
											.join("\n")
								: JSON.stringify(body);
							stream.push({ type: "done", reason: "stop", message: assistantMessage(model, [{ type: "text", text }], "stop") });
							tagLastAssistantMessageAsToolResult("rag-list");
						} else if (getMatch) {
							const docId = getMatch[1].trim();
							const res = await fetch(`${opts.baseUrl}/rag/documents/${encodeURIComponent(docId)}`);
							const body = await res.json();
							if (!res.ok) {
								throw new Error(body?.error ?? `RAG document fetch failed (HTTP ${res.status})`);
							}
							const MAX_DISPLAY_CHARS = 8000; // keep one chat message from becoming unreasonably huge
							const docText = typeof body.text === "string" ? body.text : JSON.stringify(body);
							const text =
								docText.length > MAX_DISPLAY_CHARS
									? `${docText.slice(0, MAX_DISPLAY_CHARS)}\n\n[...truncated: ${docText.length} characters total...]`
									: docText;
							stream.push({ type: "done", reason: "stop", message: assistantMessage(model, [{ type: "text", text }], "stop") });
							tagLastAssistantMessageAsToolResult("rag-get");
						}
					} catch (err) {
						const text = err instanceof Error ? err.message : String(err);
						stream.push({ type: "error", reason: "error", error: assistantMessage(model, [], "error", text) });
					}
					return; // finally{} below closes the stream
				}

				const res = await fetch(`${opts.baseUrl}/prompt`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: promptText }),
				});
				if (!res.ok || !res.body) {
					throw new Error(`loop-server responded ${res.status} ${res.statusText}`);
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				// True once the turn's first assistant message_start has been
				// forwarded as `start` — guards against re-emitting `start` for
				// a later round's message_start within the same /prompt call.
				let turnStarted = false;
				// Content blocks (typically a toolCall) from rounds already
				// finished within this /prompt call — prefixed onto every later
				// event via withAccumulated() so they survive into the final
				// message instead of being overwritten. See file header.
				const accumulatedContent: AssistantMessage["content"] = [];

				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					// SSE frames are separated by a blank line.
					const frames = buffer.split("\n\n");
					buffer = frames.pop() ?? "";

					for (const frame of frames) {
						const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
						if (!dataLine) continue;
						const payload = JSON.parse(dataLine.slice(5).trim());

						switch (payload.type) {
							case "stream_end":
								return; // finally{} below closes the stream

							case "error":
								// loop-server's own transport-level error (harness.prompt()
								// failing, serialize failure, ...) — shape is { type, message }.
								stream.push({
									type: "error",
									reason: "error",
									error: errorMessage(model, String(payload.message)),
								});
								return;

							case "message_start":
								// Only the assistant's message_start stands in for the LLM
								// stream's own `start` — the user's own message_start (echoed
								// earlier in the same turn) isn't an AssistantMessageEvent at all.
								// Guarded to fire once per /prompt call: a tool-use turn emits
								// a second assistant message_start for its follow-up round,
								// which must not reset pi-agent-core's already-open stream.
								if (payload.message?.role === "assistant" && !turnStarted) {
									turnStarted = true;
									stream.push({ type: "start", partial: payload.message });
								}
								break;

							case "message_end":
								if (payload.message?.role === "assistant") {
									const message = payload.message as AssistantMessage;
									if (message.stopReason === "toolUse") {
										// Intermediate round: Loop already executed the tool
										// server-side and is about to call the model again with
										// the result. Not the turn's real end — see file header.
										// Carry its content (the toolCall) forward so it isn't
										// lost once the next round's own content starts flowing.
										accumulatedContent.push(...message.content);
										break;
									}
									const mergedMessage: AssistantMessage = {
										...message,
										content: filterFinal([...accumulatedContent, ...message.content]),
									};
									if (message.stopReason === "error" || message.stopReason === "aborted") {
										stream.push({ type: "error", reason: message.stopReason, error: mergedMessage });
									} else {
										stream.push({
											type: "done",
											reason: message.stopReason as "stop" | "length",
											message: mergedMessage,
										});
									}
								}
								break;

							case "text_start":
							case "text_delta":
							case "text_end":
							case "thinking_start":
							case "thinking_delta":
							case "thinking_end":
							case "toolcall_start":
							case "toolcall_delta":
							case "toolcall_end":
								stream.push(withAccumulated(renameKeys(payload), accumulatedContent) as AssistantMessageEvent);
								break;

							default:
								break; // agent_start, turn_start, turn_end, agent_end, tool_execution_* — drop
						}
					}
				}
			} catch (err) {
				stream.push({
					type: "error",
					reason: "error",
					error: errorMessage(model, err instanceof Error ? err.message : String(err)),
				});
			} finally {
				stream.end();
			}
		})();

		return stream;
	};
}
