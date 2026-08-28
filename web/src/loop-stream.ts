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

/** Build a pi-agent-core StreamFn backed by a running loop-server instance. */
export function createLoopStreamFn(opts: LoopStreamFnOptions) {
	return function loopStreamFn(model: Model<Api>, context: Context, _options?: SimpleStreamOptions) {
		const stream = createAssistantMessageEventStream();

		(async () => {
			try {
				const res = await fetch(`${opts.baseUrl}/prompt`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: extractPromptText(context) }),
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
