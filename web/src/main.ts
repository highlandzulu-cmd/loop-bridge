import "./app.css";
import "@xterm/xterm/css/xterm.css";
import { Agent } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	defaultConvertToLlm,
	IndexedDBStorageBackend,
	type MessageEditor,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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

	// Slash-command autocomplete + "+" menu (/rag-query, /rag-add, /rag-list,
	// /rag-get — see loop-stream.ts) so typing "/" or clicking "+" surfaces
	// clickable options, matching how Claude's own input works. pi-web-ui
	// has no built-in slash-command support and MessageEditor's `onInput`
	// prop isn't wired up by AgentInterface (dead end, confirmed by reading
	// its render()), so the only real hook is reaching directly into the DOM
	// for the actual <textarea> — invasive, but it's light DOM (Lit's
	// createRenderRoot() overridden to return `this`, confirmed live) and
	// MessageEditor exposes a plain `value` property with a normal reactive
	// setter (no hidden side effects, confirmed by reading it) that's safe
	// to set from outside. setupSlashCommands() polls internally until
	// agent-interface/message-editor have actually rendered — a fixed
	// one-frame delay here previously wasn't enough on a real user's cold
	// hard-refresh (module fetch/parse takes longer than one frame; the
	// dev-server-cache-warmed browser this was built and re-tested in never
	// hit that), and failed completely silently when it wasn't.
	setupSlashCommands(chatPanel);

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
	// /files/content in loop-server, scoped to "/" (the whole filesystem,
	// per explicit request/confirmation — see loop-server's README).
	type PanelTab = "files" | "terminal" | "info";
	let activeTab: PanelTab = "info";

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

	// Real interactive terminal: xterm.js talking to loop-server's
	// /terminal/ws, which spawns a real PTY-backed shell server-side (see
	// loop-server's handle_terminal_socket). Container element created once
	// and referenced by identity in renderShell's template — same pattern
	// as chatPanel — so lit-html preserves it (and the live xterm.js/socket
	// inside it) across unrelated re-renders instead of tearing it down
	// every time e.g. Files is clicked.
	const terminalContainer = document.createElement("div");
	terminalContainer.style.cssText = "height: 100%; width: 100%;";
	let terminalStarted = false;

	const startTerminal = () => {
		if (terminalStarted) return;
		terminalStarted = true;

		// Deferred to the next frame: called from the tab-click handler, at
		// which point terminalContainer is still `display:none` from the
		// *previous* render (renderApp() hasn't run yet to flip it visible).
		// Verified live: fit()-ing a hidden (zero-size) container computes
		// garbage cols/rows, which the shell then draws its first prompt
		// into — a visibly wrapped, repeated-looking prompt, not a crash,
		// so easy to miss without actually looking. One rAF is enough time
		// for the now-visible layout to settle before fit() measures it.
		requestAnimationFrame(() => {
			const term = new Terminal({ fontFamily: "inherit", fontSize: 12, cursorBlink: true });
			const fit = new FitAddon();
			term.loadAddon(fit);
			term.open(terminalContainer);
			fit.fit();

			const wsUrl = LOOP_SERVER_URL.replace(/^http/, "ws") + "/terminal/ws";
			const ws = new WebSocket(wsUrl);
			ws.binaryType = "arraybuffer";

			ws.onopen = () => {
				ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
			};
			ws.onmessage = (ev) => {
				term.write(new Uint8Array(ev.data as ArrayBuffer));
			};
			ws.onerror = () => term.writeln("\r\n[connection error]");
			ws.onclose = () => term.writeln("\r\n[disconnected]");

			term.onData((data) => {
				if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
			});

			new ResizeObserver(() => {
				fit.fit();
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
				}
			}).observe(terminalContainer);
		});
	};

	// RAG used to have a second, separate frontend-side branch planned here
	// (a direct frontend -> RAG-service connection with its own Connect/
	// Disconnect toggle, meant to augment the prompt before it's sent). That
	// was never wired to anything real (augmentRagContext() always returned
	// null) and is now superseded: RAG is a real backend tool instead — see
	// crates/loop-server/README.md "Tools" and cloudflare-rag/README.md.
	// The model calls it mid-conversation when it decides to; there's
	// nothing for this frontend to connect or toggle. The dead
	// ragUrl/ragConnected/augmentRagContext/__ragAugment code that used to
	// live here (never called from anywhere, confirmed by grep) has been
	// removed rather than left around implying a mechanism that isn't real.

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
						${(["files", "terminal", "info"] as PanelTab[]).map(
							(tab) => html`
								<button
									class="pw-tab ${activeTab === tab ? "active" : ""}"
									@click=${() => {
										activeTab = tab;
										renderApp();
										if (tab === "terminal") startTerminal();
									}}
								>
									${tab[0]!.toUpperCase()}${tab.slice(1)}
								</button>
							`,
						)}
					</div>
					<div class="pw-panel-body" style="${activeTab === "terminal" ? "padding:0" : ""}">
						${activeTab === "files" ? renderFilesPanel() : ""}
						${activeTab === "info"
							? html`
									<div class="flex flex-col gap-3">
										<div><strong>Bridge:</strong> ${LOOP_SERVER_URL}</div>
										<div><strong>Session:</strong> ${sessionId}</div>
										<div class="pw-not-wired" style="text-align:left">
											This is a phase-1 visual shell recreating pi-web.dev's layout around our
											real chat (see web/README.md). Files and Terminal are real.
										</div>
									</div>
								`
							: ""}
						<div style="height:100%; display:${activeTab === "terminal" ? "block" : "none"}">
							${terminalContainer}
						</div>
					</div>
				</aside>
			</div>
		`;

	const renderApp = () => render(renderShell(), app!);
	renderApp();
}

interface SlashCommand {
	name: string; // includes the leading "/"
	hint: string;
	description: string;
}

// The commands loop-stream.ts's createLoopStreamFn actually handles. Keep
// this list and that file's RAG_*_COMMAND regexes in sync manually —
// there's no shared source of truth between the two files today (this one
// drives the menu, that one drives execution).
const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "/rag-query", hint: "<question>", description: "Query the RAG service directly — no LLM turn" },
	{ name: "/rag-add", hint: "<path>", description: "Ingest a file on disk into the RAG service" },
	{ name: "/rag-list", hint: "", description: "List every document ingested into the RAG service" },
	{ name: "/rag-get", hint: "<doc_id>", description: "Fetch the exact original text of one ingested document" },
];

/**
 * Wires up a slash-command autocomplete menu on the real chat textarea, the
 * way Claude's own input works: type "/" and see clickable options.
 *
 * pi-web-ui has no built-in support for this, and MessageEditor's `onInput`
 * prop is never passed through by AgentInterface's render() (confirmed by
 * reading it — a dead end), so this reaches directly into the DOM for the
 * actual <textarea> instead. Verified live: AgentInterface/MessageEditor
 * override Lit's `createRenderRoot()` to render into **light DOM** (`this`),
 * not a shadow root — needed so their Tailwind utility classes pick up the
 * page's global stylesheet — so plain `querySelector` reaches straight
 * through with no shadow-piercing needed at all (confirmed live:
 * `.shadowRoot` on both is `null`). MessageEditor's `value` is a plain
 * reactive property with no side effects beyond `requestUpdate` (confirmed
 * by reading its getter/setter) — safe to set from outside to fill in a
 * chosen command.
 *
 * The dropdown itself is a plain DOM element appended to `document.body`,
 * deliberately outside lit-html's renderShell() tree — it only needs to
 * exist while actively showing suggestions, and keeping it fully imperative
 * avoids fighting renderShell()'s own re-render cycle for something this
 * self-contained.
 */
/**
 * Polls for `agent-interface` -> `message-editor` -> `textarea` (+ its
 * button row) to actually exist before wiring anything up, instead of a
 * fixed one-frame delay after `setAgent()` resolves.
 *
 * The original version used a single `requestAnimationFrame` and worked
 * fine in every one of this session's own test passes — but those all ran
 * against an already-warm dev-server module cache from repeated reloads.
 * On a genuinely cold load (a real user's first hard-refresh, full
 * re-fetch/re-parse of every module) `AgentInterface`'s own reactive
 * render can plausibly take longer than one frame to actually insert
 * `<message-editor>`, so the one-shot check silently found nothing and
 * gave up — no `+` button, no autocomplete, no error, nothing logged.
 * Hit live: a real user's hard-refreshed browser showed neither feature
 * at all despite the dev server correctly serving the updated code.
 */
function setupSlashCommands(chatPanel: ChatPanel, attemptsLeft = 50) {
	const agentInterface = chatPanel.agentInterface;
	const messageEditor = agentInterface?.querySelector("message-editor") as MessageEditor | null;
	const textarea = messageEditor?.querySelector("textarea");
	if (!agentInterface || !messageEditor || !textarea) {
		if (attemptsLeft > 0) {
			setTimeout(() => setupSlashCommands(chatPanel, attemptsLeft - 1), 100);
		}
		// After ~5s of retrying, give up silently rather than loop forever —
		// at that point something else is genuinely wrong (not just slow to
		// render) and retrying further wouldn't help.
		return;
	}
	initSlashCommands(messageEditor, textarea);
}

function initSlashCommands(messageEditor: MessageEditor, textarea: HTMLTextAreaElement) {
	// MessageEditor's button row, left-to-right: attachment (paperclip),
	// [thinking selector], ..., [model selector], send/stop — the send
	// button is reliably the last one, regardless of which optional buttons
	// in between are showing. No id/aria-label to key off instead (checked
	// MessageEditor.ts's render()), so this is coupled to that ordering.
	const buttons = messageEditor.querySelectorAll("button");
	const sendButton = buttons[buttons.length - 1] as HTMLElement | undefined;

	const menu = document.createElement("div");
	menu.className = "pw-slash-menu";
	menu.style.cssText =
		"position:fixed; display:none; z-index:1000; background:var(--card); border:1px solid var(--border); border-radius:8px; overflow:hidden; box-shadow:0 4px 16px rgba(0,0,0,0.2); font-family:inherit;";
	document.body.appendChild(menu);

	let filtered: SlashCommand[] = [];
	let highlighted = 0;

	const hide = () => {
		menu.style.display = "none";
		filtered = [];
	};

	const select = (cmd: SlashCommand) => {
		messageEditor.value = `${cmd.name} `;
		hide();
		// messageEditor.value's setter triggers a Lit re-render (async), so
		// the real textarea's value/caret aren't updated yet on this tick.
		requestAnimationFrame(() => {
			textarea.focus();
			const len = textarea.value.length;
			textarea.setSelectionRange(len, len);
		});
	};

	const renderMenu = () => {
		menu.innerHTML = "";
		filtered.forEach((cmd, i) => {
			const item = document.createElement("div");
			item.style.cssText = `padding:8px 12px; cursor:pointer; font-size:12px; ${i === highlighted ? "background:var(--accent);" : ""}`;
			// Built with textContent, not innerHTML — cmd.hint contains literal
			// "<" / ">" (e.g. "<question>"), which innerHTML would parse as an
			// (unknown, invisible) HTML tag rather than display as text. Hit
			// live: the hints silently vanished on first try.
			const nameLine = document.createElement("div");
			nameLine.style.fontWeight = "600";
			nameLine.append(`${cmd.name} `);
			const hint = document.createElement("span");
			hint.style.cssText = "opacity:0.6; font-weight:400";
			hint.textContent = cmd.hint;
			nameLine.append(hint);
			const descLine = document.createElement("div");
			descLine.style.cssText = "opacity:0.65; font-size:11px; margin-top:2px";
			descLine.textContent = cmd.description;
			item.append(nameLine, descLine);
			// mousedown, not click: fires before the textarea would blur, so
			// select() can still refocus it afterward without a visible flicker.
			item.addEventListener("mousedown", (e) => {
				e.preventDefault();
				select(cmd);
			});
			item.addEventListener("mouseenter", () => {
				highlighted = i;
				renderMenu();
			});
			menu.appendChild(item);
		});
	};

	// anchor defaults to the textarea (autocomplete-while-typing case) but
	// the "+" button below positions the same menu against itself instead.
	const updatePosition = (anchor: HTMLElement = textarea) => {
		const rect = anchor.getBoundingClientRect();
		menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 268))}px`;
		menu.style.width = anchor === textarea ? `${rect.width}px` : "260px";
		menu.style.bottom = `${window.innerHeight - rect.top + 8}px`;
	};

	const handleInput = () => {
		// Only while the whole input is still just "/" + a partial command
		// name — once a space is typed (the command's argument starting),
		// the menu should get out of the way.
		const match = textarea.value.match(/^\/(\S*)$/);
		if (!match) {
			hide();
			return;
		}
		const typed = match[1].toLowerCase();
		filtered = SLASH_COMMANDS.filter((c) => c.name.slice(1).toLowerCase().startsWith(typed));
		if (filtered.length === 0) {
			hide();
			return;
		}
		highlighted = 0;
		updatePosition();
		menu.style.display = "block";
		renderMenu();
	};

	textarea.addEventListener("input", handleInput);
	// Capture phase so this runs before MessageEditor's own keydown handler
	// (which sends the message on plain Enter) — stopImmediatePropagation
	// keeps that handler from also firing when a suggestion is being picked.
	textarea.addEventListener(
		"keydown",
		(e) => {
			if (menu.style.display === "none") return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				e.stopImmediatePropagation();
				highlighted = (highlighted + 1) % filtered.length;
				renderMenu();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				e.stopImmediatePropagation();
				highlighted = (highlighted - 1 + filtered.length) % filtered.length;
				renderMenu();
			} else if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				e.stopImmediatePropagation();
				select(filtered[highlighted]);
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopImmediatePropagation();
				hide();
			}
		},
		true,
	);
	window.addEventListener("resize", () => {
		if (filtered.length > 0) updatePosition();
	});

	// "+" button: an always-available way to browse every command by
	// clicking, not just by knowing to type "/" — reuses this same menu
	// (full, unfiltered list) rather than building a second one.
	let plusButton: HTMLButtonElement | undefined;
	if (sendButton) {
		plusButton = document.createElement("button");
		plusButton.className = "pw-slash-plus";
		plusButton.type = "button";
		plusButton.setAttribute("aria-label", "Tool commands");
		plusButton.textContent = "+";
		plusButton.style.cssText =
			"position:fixed; z-index:999; width:32px; height:32px; border-radius:50%; border:1px solid var(--border); background:var(--card); color:var(--foreground); font-family:inherit; font-size:16px; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center;";
		document.body.appendChild(plusButton);

		const updatePlusPosition = () => {
			const rect = sendButton.getBoundingClientRect();
			// Sits just left of the send button, vertically centered on it.
			plusButton!.style.left = `${rect.left - 40}px`;
			plusButton!.style.top = `${rect.top + rect.height / 2 - 16}px`;
		};
		updatePlusPosition();
		window.addEventListener("resize", updatePlusPosition);
		// The button row's own layout can shift (e.g. attachments appearing
		// changes message-editor's height, which can move the row within the
		// page even though the row's internal position doesn't change) —
		// cheap to just recompute on every textarea input too.
		textarea.addEventListener("input", updatePlusPosition);

		plusButton.addEventListener("mousedown", (e) => {
			e.preventDefault(); // don't blur the textarea
			if (menu.style.display !== "none" && filtered === SLASH_COMMANDS) {
				hide();
				return;
			}
			filtered = SLASH_COMMANDS;
			highlighted = 0;
			updatePosition(plusButton!);
			menu.style.display = "block";
			renderMenu();
		});
	}

	// One combined "click outside closes the menu" listener — has to know
	// about both possible openers (typing in the textarea, or the "+"
	// button) so picking one doesn't immediately re-close what the other
	// just opened via the same mousedown event.
	document.addEventListener("mousedown", (e) => {
		if (filtered.length === 0) return;
		if (e.target === textarea || e.target === plusButton || menu.contains(e.target as Node)) return;
		hide();
	});
}

main();
