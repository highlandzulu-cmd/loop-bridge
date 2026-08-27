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
 * are dropped here and left to stream straight through to `done` (their
 * text_delta events, if any, still flow into the one open message). This
 * means an intermediate tool call itself isn't shown in the UI, only the
 * final text — acceptable for now, but revisit if the UI should surface
 * "ran tool X" as it happens.
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
										break;
									}
									if (message.stopReason === "error" || message.stopReason === "aborted") {
										stream.push({ type: "error", reason: message.stopReason, error: message });
									} else {
										stream.push({
											type: "done",
											reason: message.stopReason as "stop" | "length",
											message,
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
								// toolcall_* intentionally excluded for v1 — see file header note.
								stream.push(renameKeys(payload) as AssistantMessageEvent);
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
