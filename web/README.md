# web (loop-web)

Browser chat UI for [`loop-server`](../crates/loop-server/README.md), built
on [`pi-web-ui`](https://www.npmjs.com/package/@mariozechner/pi-web-ui) /
`pi-agent-core`. This app does no thinking and has no tools of its own —
it's a renderer. Every real action (running a shell command, editing a
file) happens server-side in `loop-server`/`AgentHarness`; see that crate's
README for the architecture diagram.

## Layout — phase 1 of 2, Files and Terminal real (Git tab removed)

The 3-column shell (sidebar / chat / tabbed side panel) in `main.ts` +
`app.css` is modeled on [pi-web.dev](https://pi-web.dev) (a separate,
full-featured product built on the same `pi-web-ui`/`pi-agent-core`
libraries — see [jmfederico/pi-web](https://github.com/jmfederico/pi-web)).

- Sidebar (Project/Model/Session) shows real data from `loop-server`'s
  `/health` endpoint and `.env` — not fabricated
- **Files tab is real** — browses the **whole filesystem**, not just the
  project directory, via `loop-server`'s `GET /files` / `/files/content`
  (see that crate's README — this scope was widened from
  project-directory-only on explicit request/confirmation; read that
  note before assuming it's still sandboxed). Click a folder to navigate
  in, a file to preview its content, "← .." to go back up.
- **Terminal tab is real** — `xterm.js` talking to `loop-server`'s
  `GET /terminal/ws`, which spawns an actual PTY-backed shell server-side
  (see that crate's README for the protocol and how it's verified). The
  container element (`terminalContainer`) is created once and referenced
  by identity in the template, same pattern as `chatPanel`, so switching
  tabs doesn't tear down and reconnect the live session. One real bug
  fixed here: `FitAddon.fit()` called while the panel was still
  `display:none` (before the tab-switch re-render made it visible)
  measured a zero-size container and computed garbage terminal
  dimensions — visible as a wrapped, repeated-looking first prompt, not a
  crash, easy to miss without actually looking closely. Fixed by
  deferring the whole `xterm.js`/WebSocket setup one `requestAnimationFrame`
  past the tab click, after the container is actually laid out.
- The chat column is the actual, fully working bridge — same as before

Git tab (was an honest placeholder) has been removed at the user's
request rather than left as dead UI — no code references it anymore.

## RAG — no frontend UI, it's a backend tool

There used to be a second, separate sidebar card here: a Connect/Disconnect
toggle for a planned direct frontend-to-RAG-service branch (query RAG in
the browser, fold results into the prompt before sending). It was never
wired to anything real (`augmentRagContext()` in `main.ts` always returned
`null`) and has been removed — both the card and that dead code — rather
than left implying a mechanism that isn't real.

RAG is real now, but entirely on the backend: `rag_query` (see
`crates/loop-server/README.md` "Tools") is a tool the *model* can choose to
call mid-conversation, configured server-side via `RAG_SERVICE_URL` /
`RAG_SERVICE_API_KEY` in `.env`, currently pointed at a live Cloudflare
Worker (`cloudflare-rag/`). There's nothing to connect or toggle from this
frontend — the model just calls it when it decides to, same as any other
tool. Verified end-to-end through this actual chat UI, not just the API
directly.

### `/rag-query`, `/rag-add`, `/rag-list`, `/rag-get` — manual, deterministic shortcuts

Four slash commands, typed directly into the normal chat message box:

- `/rag-query <question>` — queries the RAG service directly via
  `loop-server`'s `POST /rag/query`, with **no LLM turn involved at all**.
  Faster and free of any model hallucination risk versus asking normally
  and hoping the model decides to call the `rag_query` tool. This does
  *semantic* retrieval, not an exact lookup — `/rag-query launch-doc`
  searches for content matching the literal words "launch-doc", it doesn't
  fetch the document with that ID (that's `/rag-get`, below).
- `/rag-add <path>` — ingests a file already on disk (PDF or text) into the
  RAG service via `loop-server`'s `POST /rag/ingest`, so it becomes
  queryable. `path` is resolved on the *server* machine, not the browser.
- `/rag-list` — lists every document the RAG service has ingested (id,
  chunk count, timestamp) via `loop-server`'s `GET /rag/documents`. No
  argument.
- `/rag-get <doc_id>` — fetches the **exact original text** of one
  ingested document by its id via `loop-server`'s `GET
  /rag/documents/:id` — a real lookup, not semantic search dressed up to
  look like one. Use `/rag-list` first to see valid ids.

All four are handled in `loop-stream.ts`'s `createLoopStreamFn` — the only
real seam available to intercept a message before it reaches pi-agent-core
(see that file's header comment for why: `ChatPanel`'s own send flow is
owned entirely by the `pi-web-ui` library, with `extractPromptText`/this
`StreamFn` as the one customization point this app has). A matched command
short-circuits the whole `/prompt` SSE path and instead calls the direct
endpoint once, then synthesizes a `start`/`done` event pair so
pi-agent-core renders the result as a normal assistant message — real
retrieval/ingestion, not a fake "thinking" animation. The match is against
a *trimmed* copy of the typed text — a stray leading space (hit live
during testing) silently fell through to a real, wasted LLM turn instead
of the intended command before this was added.

Verified end-to-end live, including the eventual-consistency edge case:
`/rag-add`ing a new file and immediately `/rag-query`ing it correctly
returned "I don't see the answer in the provided context" (Vectorize
hadn't indexed it yet — a few seconds' lag, not a bug) rather than
hallucinating one, then returned the correct answer once indexed. Also
verified live: `/rag-list` showing all 5 ingested docs with real chunk
counts and timestamps, and `/rag-get launch-doc` returning the exact
original text with no LLM involvement.

### Slash-command autocomplete

Typing `/` followed by a partial command name (e.g. `/rag`) shows a
clickable dropdown of matching commands with their argument hint and a
one-line description — arrow keys to move, Enter/Tab to accept, Escape to
dismiss, or click directly. Matches how Claude's own input works.

pi-web-ui has no built-in support for this. `setupSlashCommands()` in
`main.ts` reaches directly into the DOM for the real `<textarea>` inside
`AgentInterface`/`MessageEditor` — verified live that both components
override Lit's `createRenderRoot()` to render into **light DOM** (`this`)
rather than a shadow root (needed so their Tailwind classes pick up the
page's global stylesheet), so plain `querySelector` reaches straight
through, no shadow-piercing needed. The dropdown is a plain DOM element
appended to `document.body`, deliberately outside lit-html's `renderShell()`
tree — simpler than fighting that render cycle for something this
self-contained.

**Verification note, same category as the Terminal panel's already-documented
Enter-key caveat:** typing and filtering were verified live through real
browser automation (screenshots confirm `/rag` showing both options,
`/rag-q` correctly filtering to one). The click-to-select and keyboard-accept
paths were verified correct at the code level — a real `mousedown` event
dispatched at the exact on-screen coordinates of a menu item correctly set
the textarea's value and closed the menu — but this specific automation
tool's synthesized clicks and key presses didn't reliably land on this
custom `position:fixed` overlay in this environment (and interleaving
JS-inspection calls between actions was independently confirmed to blur
focus off the textarea entirely — `document.activeElement` became `<body>`).
Real mouse clicks and keystrokes in an actual browser go through none of
that; this is a testing-tool limitation, not a product bug — the same
conclusion reached for Terminal's Enter key, for the same underlying reason
(synthetic input into custom, non-native-`<input>`-adjacent UI).

### "+" button — browse commands without knowing to type "/"

A small circular `+` button sits just left of the send button (positioned
via the same `position:fixed`-anchored-to-a-library-element technique as
the dropdown, anchored to whichever button is last in `MessageEditor`'s
button row — reliably the send button regardless of which optional buttons
in between are showing). Clicking it opens the exact same dropdown, just
unfiltered — every command, not a typed-prefix match. Selecting one fills
in the textarea the same way. A second click on `+` while its own
unfiltered menu is open closes it again; clicking `+` while the
typed-filter menu is open instead switches to the full list.

Verified live end-to-end (button click confirmed via screenshot, item
selection confirmed via the same direct-`mousedown`-dispatch method noted
above for the same automation-tool reason) — selecting `/rag-list` from
the `+` menu, then sending, produced a correct, fully-highlighted result
(see below).

### Highlighting RAG results — "like Claude"

`/rag-query`, `/rag-add`, `/rag-list`, and `/rag-get` results render
visually distinct from normal model replies: a purple left border and
tinted background (vs. the baseline teal accent every assistant message
already has) plus a small uppercase command label, e.g. `RAG-QUERY`, above
the content.

Deliberately **not** built by giving the synthesized message a real
`toolCall` content block, which would let pi-web-ui's own native
`<tool-message>` card render it (nicer, closer to "the library's own tool
UI") — `loop-stream.ts`'s file header already documents a real regression
hit while building basic `/rag-query` support: a `done` message containing
a `toolCall` block makes pi-agent-core try to execute it itself, fail
(this app's `Agent` has no registered tools), and fire a bogus follow-up
request. Achieving a real `toolResult` pairing instead would mean mutating
`agent.state.messages` directly from outside the whole `StreamFn` contract
— a bigger, separately-risky change, not taken on for a visual-only ask.

Instead, `tagLastAssistantMessageAsToolResult()` in `loop-stream.ts` runs
right after each command's synthesized `done` event: finds the
`<assistant-message>` element that response just became (light DOM again,
so plain `querySelectorAll`) and tags it directly with a CSS class +
label attribute, styled in `app.css`. Safe specifically because nothing
else ever runs concurrently with a `/rag-*` command (no real model turn in
flight) — "the last `<assistant-message>` in the DOM right now" is
unambiguous.

Verified live: `/rag-list`, `/rag-query`, and a normal (non-command)
message sent back to back in the same conversation — screenshots confirm
the two RAG results both render with the purple highlight + correct
uppercase label, and the plain "say hello" reply in between renders with
the normal teal-accent styling only, un-highlighted. No false positives.

## Running it

From the repo root:

```bash
./scripts/dev.sh
```

builds and starts this together with `loop-server`. To run just this piece
(with `loop-server` already running separately on port 8787):

```bash
npm install   # first time only
npm run dev
```

Opens on `http://localhost:5173`. That origin has to match
`loop-server`'s `LOOP_SERVER_CORS_ORIGIN` or requests are blocked by CORS —
they match by default, only relevant if you change one.

## How it's wired together

- [`src/main.ts`](src/main.ts) — sets up `pi-web-ui`'s `ChatPanel` with a
  `pi-agent-core` `Agent` whose `streamFn` is our own adapter instead of a
  direct provider call, and `tools: []` (deliberately empty — see below).
- [`src/loop-stream.ts`](src/loop-stream.ts) — the actual bridge. A
  `pi-agent-core` `StreamFn` that POSTs to `loop-server`'s `/prompt` and
  translates its SSE `AgentEvent` stream into the `AssistantMessageEvent`
  shape `pi-agent-core` expects. **Read the comment block at the top of
  this file before changing it** — it documents a real, non-obvious bug
  class (multi-round tool-use turns) that's easy to reintroduce.

**Why `tools: []`:** `loop-server`/`AgentHarness` already executes tools
server-side and streams back the result — this frontend must never also try
to run them. Registering any tool here would make `pi-agent-core`'s own
generic agent loop think *it* owns execution, which fails immediately (a
browser can't run `bash`) and produces conflicting requests. If you're
adding a new tool to the harness, it belongs in `loop-agent`/`loop-cli`
config, not here.

## Bugs found and fixed here, worth knowing before touching this code

All root-caused live (not guessed at) and documented in detail at their fix
site — this is just the index:

1. **SSE connection never closed** — fixed in `loop-server`, not here; see
   its `main.rs`. Symptom from this side: requests would hang open long
   after the real response had already finished.
2. **Tool-use turns reported as done after round one** — a tool-use turn is
   actually *multiple* model-call rounds server-side. Surfacing the first
   round's completion as the whole turn being `done` made `pi-agent-core`
   try to execute the tool itself. Fixed in `loop-stream.ts` — see the
   comment block at its top.
3. **Send button stuck on "stop" after every turn** — a genuine timing bug
   in `pi-agent-core` itself (`agent_end` fires before `isStreaming` flips
   back to `false`, with no follow-up notification once it does). Worked
   around in `main.ts` — see the comment right above the `agent.subscribe`
   call there for the full root cause and why the fix has to be deferred a
   tick.
4. **Tool call visible while running, then a second bogus reply appeared**
   — a follow-up fix on top of #2: once tool calls started being forwarded
   for display, merging one into the *final* `done` message made
   `pi-agent-core` try to execute it again regardless of `stopReason`
   (its own `runLoop` checks for a `toolCall` in `content` unconditionally),
   fail, inject a fake toolResult, then fire an empty-text follow-up
   request. Caught live by inspecting `session.state.messages` after a
   send. Fixed in `loop-stream.ts` (`filterFinal`) — toolCall blocks are
   stripped before the true `done`, kept only in the streaming view.
5. **Attachments (PDF/image) silently vanished, attachment and typed text
   both** — `pi-agent-core`'s own default `convertToLlm` filters messages
   down to only `role: "user"/"assistant"/"toolResult"`, silently, no
   error. Attaching a file produces `role: "user-with-attachments"`, which
   that filter just drops — the whole turn, not just the attachment.
   `main.ts` never overrode it. Fixed by wiring in `pi-web-ui`'s own
   `defaultConvertToLlm` (also publicly exported) via the `Agent`'s
   `convertToLlm` option — it correctly unpacks that role into the
   attachment's extracted text as a normal text block. Verified live and
   unambiguously: a synthetic attachment containing a random marker string
   came back quoted in the model's response.

Related, hit separately (fixed in `../vite.config.ts`, not here): the
first PDF attached in a dev session could also fail outright with
`Setting up fake worker failed` — Vite's on-demand dependency
pre-bundling racing pdfjs-dist's worker setup. `optimizeDeps.exclude:
["pdfjs-dist"]` sidesteps it.

## Known gaps / open work

- **Conversation history doesn't survive a page reload.** `loop-server`
  correctly persists session state server-side, but this frontend's own
  session store isn't wired to fetch and replay that history on load — a
  refresh shows a blank chat even though the harness still remembers
  everything. Next message still uses the real server-side context
  correctly; it's a display-only gap.
- **A tool call is only visible *while it's running*, not afterward.**
  `loop-stream.ts` now forwards `toolcall_*` events so a running tool shows
  up live, but strips that content back out before finalizing the message
  (bug #4 above) — so it folds away once the turn completes. Showing it
  permanently would need a `ToolResultMessage` spliced directly into
  `agent.state.messages` from outside the `StreamFn` contract entirely —
  a real architectural limit of this approach, not a bug left unfixed. See
  the "WHAT THIS STILL CAN'T DO" note in `loop-stream.ts`'s header.
- **The model selector in the UI is decorative.** `pi-web-ui` shows one by
  default (`enableModelSelector`), but the real model is fixed server-side
  at `loop-server` startup via `LOOP_SERVER_MODEL` — picking a different
  one in the UI currently does nothing.
- **The "Artifacts" panel/tool is unrelated to Loop.** `pi-web-ui`
  auto-registers its own client-side "artifacts" tool (a local file-like
  scratchpad, backed by IndexedDB) regardless of what's passed as `tools:
  []`. It works standalone and doesn't go through `loop-server` at all —
  don't confuse it with one of Loop's actual tools (`bash`/`read`/`write`/`edit`)
  if you see it mentioned in the UI or console.
