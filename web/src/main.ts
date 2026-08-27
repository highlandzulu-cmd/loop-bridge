import "./app.css";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { createLoopStreamFn } from "./loop-stream.js";

// Bridge URL — the Rust loop-server from crates/loop-server.
const LOOP_SERVER_URL = "http://127.0.0.1:8787";

// Placeholder Model purely for display (name, cost formatting) in the UI.
// The real model choice lives entirely on the Loop/Rust side; this value is
// never sent anywhere — our streamFn ignores it and calls loop-server instead.
const loopModel: Model<"openai-completions"> = {
	id: "loop-harness",
	name: "Loop",
	api: "openai-completions",
	provider: "loop",
	baseUrl: LOOP_SERVER_URL,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8192,
};

async function main() {
	const app = document.getElementById("app");
	if (!app) throw new Error("missing #app container");

	// pi-web-ui's ChatPanel requires its storage layer to be initialized even
	// when, as here, we don't use it for anything (no persisted sessions,
	// no provider keys — Loop owns all real state server-side). This is
	// required boilerplate, not something specific to our setup.
	const settings = new SettingsStore();
	const providerKeys = new ProviderKeysStore();
	const sessions = new SessionsStore();
	const customProviders = new CustomProvidersStore();
	const backend = new IndexedDBStorageBackend({
		dbName: "loop-web-ui",
		version: 1,
		stores: [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			customProviders.getConfig(),
			sessions.getConfig(),
		],
	});
	settings.setBackend(backend);
	providerKeys.setBackend(backend);
	customProviders.setBackend(backend);
	sessions.setBackend(backend);
	setAppStorage(new AppStorage(settings, providerKeys, sessions, customProviders, backend));

	const agent = new Agent({
		initialState: {
			systemPrompt: "", // Loop's own harness supplies the real system prompt server-side.
			model: loopModel,
			thinkingLevel: "off",
			messages: [],
			tools: [], // Loop executes tools server-side; nothing to register here (see loop-stream.ts).
		},
		streamFn: createLoopStreamFn({ baseUrl: LOOP_SERVER_URL }),
	});

	const chatPanel = new ChatPanel();
	await chatPanel.setAgent(agent, {
		// pi-web-ui's send flow checks for a stored provider API key before
		// every send, regardless of whether the Agent has a custom streamFn
		// (it doesn't know ours bypasses the need for one). Since Loop's
		// harness holds the real credentials server-side, just tell the UI
		// to proceed — there's nothing to prompt the user for.
		onApiKeyRequired: async () => true,
	});

	// setAgent() unconditionally turns this on with no way to opt out via its
	// config param — but it's decorative here: the real model is fixed
	// server-side at loop-server startup (LOOP_SERVER_MODEL), and picking a
	// different one in this UI wouldn't do anything. Leaving it on would be
	// actively misleading, so turn it back off on the property directly.
	// Revisit if/when loop-server grows support for switching models at
	// runtime instead of only at process startup.
	if (chatPanel.agentInterface) {
		chatPanel.agentInterface.enableModelSelector = false;
	}

	// Verified live, root-caused: pi-agent-core's Agent mutates state.messages
	// in place (same array reference across turns) instead of replacing it.
	// AgentInterface's internal agent.subscribe() handler does correctly call
	// requestUpdate() on every lifecycle event — confirmed all of them fire —
	// but Lit's default property change detection on <message-list>'s
	// `messages` property is a `!==` reference check, so re-assigning the
	// *same* array is a no-op and that component's own render() never re-runs.
	// The result: the chat visibly lags one full turn behind until something
	// else forces it to catch up. Not a bug in Loop or in this adapter —
	// agent.state itself is correct at every point checked live. Cheapest fix
	// without patching a third-party dependency: force the specific elements
	// whose property-level change detection is being fooled to update anyway.
	//
	// Separate pi-agent-core bug also strands the send button after every
	// turn. Root-caused live in agent.js: runWithLifecycle() emits "agent_end"
	// from inside executor(), and only *after* that promise resolves does its
	// `finally` block (finishRun()) set state.isStreaming = false — with no
	// further notification to subscribers once it does. So requestUpdate()
	// called synchronously from an "agent_end" handler (ours or
	// AgentInterface's own internal one, which does call it) still observes
	// isStreaming: true, re-renders to confirm the *streaming* look, and
	// nothing ever prompts another render once it flips false a moment later.
	// <message-editor>'s isStreaming (what the send button's icon/enabled
	// state reads) is only ever assigned via a template binding inside
	// AgentInterface's render(), so it's left stuck showing "stop" and the
	// next message can't be sent. Fix: defer our requestUpdate() past the
	// current microtask/macrotask so it runs after finishRun() — confirmed
	// live this reliably un-sticks it every time.
	agent.subscribe((event) => {
		if (event.type === "agent_end" || event.type === "message_update") {
			setTimeout(() => {
				for (const el of chatPanel.querySelectorAll("message-list, streaming-message-container, agent-interface")) {
					(el as { requestUpdate?: () => void }).requestUpdate?.();
				}
			}, 0);
		}
	});

	render(
		html`
			<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
				<div class="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
					<span class="text-base font-semibold">Loop Chat</span>
					<span class="text-xs text-muted-foreground">— talking to ${LOOP_SERVER_URL}</span>
				</div>
				${chatPanel}
			</div>
		`,
		app,
	);
}

main();
