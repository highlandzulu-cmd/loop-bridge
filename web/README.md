# web (loop-web)

Browser chat UI for [`loop-server`](../crates/loop-server/README.md), built
on [`pi-web-ui`](https://www.npmjs.com/package/@mariozechner/pi-web-ui) /
`pi-agent-core`. This app does no thinking and has no tools of its own —
it's a renderer. Every real action (running a shell command, editing a
file) happens server-side in `loop-server`/`AgentHarness`; see that crate's
README for the architecture diagram.

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

All three were root-caused live (not guessed at) and are documented in
detail at their fix site — this is just the index:

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

## Known gaps / open work

- **Conversation history doesn't survive a page reload.** `loop-server`
  correctly persists session state server-side, but this frontend's own
  session store isn't wired to fetch and replay that history on load — a
  refresh shows a blank chat even though the harness still remembers
  everything. Next message still uses the real server-side context
  correctly; it's a display-only gap.
- **Tool calls aren't shown in the UI**, only the final text answer —
  `loop-stream.ts` intentionally drops `toolcall_*` events for now (see its
  header comment for why forwarding them naively would cause a UI flash).
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
