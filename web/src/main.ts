import "./app.css";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	defaultConvertToLlm,
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
		// pi-agent-core's own default convertToLlm drops any message whose
		// role isn't exactly "user"/"assistant"/"toolResult" — silently, no
		// error. An attached PDF/image produces role "user-with-attachments",
		// so without this override that whole turn (attachment AND any typed
		// text alongside it) vanished before reaching loop-stream.ts, and the
		// harness saw nothing. pi-web-ui ships its own convertToLlm that
		// properly unpacks that role into a normal "user" message with the
		// attachment's extracted text folded in — this just opts into it.
		convertToLlm: defaultConvertToLlm,
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

	// Real session id from the running bridge — shown in the sidebar instead
	// of fabricating one. Health check also doubles as "is loop-server up".
	let sessionId = "unknown";
	try {
		const health = await fetch(`${LOOP_SERVER_URL}/health`).then((r) => r.json());
		sessionId = health.session_id ?? "unknown";
	} catch {
		// loop-server not reachable yet — sidebar just shows "unknown".
	}

	// Phase 1 shell: recreates pi-web.dev's layout (sidebar, chat, tabbed side
	// panel) around our real, working chat. Git/Terminal panels are honest
	// placeholders — loop-server has no backend for those yet (see
	// web/README.md "Phase 2"). Files is real now: GET /files and
	// /files/content in loop-server, scoped to the project directory.
	type PanelTab = "files" | "git" | "terminal" | "info";
	let activeTab: PanelTab = "info";

	const notWired = (label: string) => html`
		<div class="pw-not-wired">
			${label} isn't wired up yet — loop-server doesn't have a ${label.toLowerCase()} backend.<br />
			The chat on the left is the real, working part.
		</div>
	`;

	interface FileEntry {
		name: string;
		is_dir: boolean;
		size: number;
	}
	interface FileContent {
		path: string;
		size: number;
		content: string | null;
		message?: string;
	}

	let filesPath = "";
	let filesEntries: FileEntry[] | null = null;
	let filesError: string | null = null;
	let filesLoaded = false;
	let selectedFile: FileContent | null = null;

	const loadFiles = async (path: string) => {
		filesPath = path;
		selectedFile = null;
		filesError = null;
		try {
			const res = await fetch(`${LOOP_SERVER_URL}/files?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
			filesEntries = (await res.json()).entries;
		} catch (err) {
			filesEntries = null;
			filesError = err instanceof Error ? err.message : String(err);
		}
		filesLoaded = true;
		renderApp();
	};

	const openFile = async (path: string) => {
		selectedFile = null;
		filesError = null;
		try {
			const res = await fetch(`${LOOP_SERVER_URL}/files/content?path=${encodeURIComponent(path)}`);
			if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
			selectedFile = await res.json();
		} catch (err) {
			filesError = err instanceof Error ? err.message : String(err);
		}
		renderApp();
	};

	const renderFilesPanel = () => {
		if (!filesLoaded) {
			loadFiles("");
			return html`<div>Loading…</div>`;
		}
		if (selectedFile) {
			return html`
				<div class="flex flex-col gap-2">
					<button class="pw-tab" @click=${() => loadFiles(filesPath)}>← ${filesPath || "/"}</button>
					<div style="font-weight:600">${selectedFile.path}</div>
					${selectedFile.content !== null
						? html`<pre style="white-space:pre-wrap; word-break:break-word; font-size:11.5px">${selectedFile.content}</pre>`
						: html`<div class="pw-not-wired">${selectedFile.message}</div>`}
				</div>
			`;
		}
		const parent = filesPath.includes("/") ? filesPath.slice(0, filesPath.lastIndexOf("/")) : "";
		return html`
			<div class="flex flex-col gap-1">
				<div style="font-weight:600; margin-bottom:4px">/${filesPath}</div>
				${filesPath
					? html`<button class="pw-tab" style="align-self:flex-start" @click=${() => loadFiles(parent)}>← ..</button>`
					: ""}
				${filesError ? html`<div class="pw-not-wired">${filesError}</div>` : ""}
				${(filesEntries ?? []).map((entry) => {
					const entryPath = filesPath ? `${filesPath}/${entry.name}` : entry.name;
					return html`
						<button
							class="pw-tab"
							style="justify-content:flex-start; text-align:left"
							@click=${() => (entry.is_dir ? loadFiles(entryPath) : openFile(entryPath))}
						>
							${entry.is_dir ? "📁" : "📄"} ${entry.name}
						</button>
					`;
				})}
			</div>
		`;
	};

	const renderShell = () =>
		html`
			<div class="pw-shell">
				<aside class="pw-sidebar">
					<div class="pw-sidebar-header">
						<span>LOOP CHAT</span>
					</div>
					<div class="pw-section-label"><span>PROJECT</span></div>
					<div class="pw-card active">
						<div class="pw-card-title">loop</div>
						<div class="pw-card-sub">~/Desktop/loop</div>
					</div>
					<div class="pw-section-label"><span>MODEL</span></div>
					<div class="pw-card">
						<div class="pw-card-title">${LOOP_SERVER_URL}</div>
						<div class="pw-card-sub">set via LOOP_SERVER_MODEL in .env</div>
					</div>
					<div class="pw-section-label"><span>SESSION</span></div>
					<div class="pw-card active">
						<div class="pw-card-title">${sessionId.slice(0, 18)}${sessionId.length > 18 ? "…" : ""}</div>
						<div class="pw-card-sub">persisted server-side by loop-server</div>
					</div>
				</aside>

				<div class="pw-chat-col">${chatPanel}</div>

				<aside class="pw-panel">
					<div class="pw-tabs">
						${(["files", "git", "terminal", "info"] as PanelTab[]).map(
							(tab) => html`
								<button
									class="pw-tab ${activeTab === tab ? "active" : ""}"
									@click=${() => {
										activeTab = tab;
										renderApp();
									}}
								>
									${tab[0]!.toUpperCase()}${tab.slice(1)}
								</button>
							`,
						)}
					</div>
					<div class="pw-panel-body">
						${activeTab === "files" ? renderFilesPanel() : ""}
						${activeTab === "git" ? notWired("Git") : ""}
						${activeTab === "terminal" ? notWired("Terminal") : ""}
						${activeTab === "info"
							? html`
									<div class="flex flex-col gap-3">
										<div><strong>Bridge:</strong> ${LOOP_SERVER_URL}</div>
										<div><strong>Session:</strong> ${sessionId}</div>
										<div class="pw-not-wired" style="text-align:left">
											This is a phase-1 visual shell recreating pi-web.dev's layout around our
											real chat (see web/README.md). Files/Git/Terminal are placeholders —
											wiring them up for real is a separate, later task.
										</div>
									</div>
								`
							: ""}
					</div>
				</aside>
			</div>
		`;

	const renderApp = () => render(renderShell(), app!);
	renderApp();
}

main();
