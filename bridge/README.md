# loop-server

HTTP/SSE bridge that exposes Loop's `AgentHarness` to a web frontend. This
process does no thinking of its own — it boots a real harness the same way
`loop-cli` does, then translates the harness's internal `AgentEvent` stream
into JSON events pushed to the browser over Server-Sent Events.

```
browser (pi-web-ui)  ──POST /prompt──▶  loop-server  ──▶  AgentHarness  ──▶  LLM provider
        ▲                                    │                  │
        └──────────── SSE event stream ◀─────┘                  └─▶ tools (bash/read/write/edit)
                                                                      run for real, on this machine
```

Everything the model can *do* — running a shell command, reading/writing a
file — happens **server-side, in this process**, on the real machine it runs
on. The browser has no tools of its own and never executes anything; it's a
renderer for the event stream. See [`../web/README.md`](../web/README.md)
for the frontend side of this.

## How this connects to the harness

`AgentHarness` (and the `bootstrap()`/`build_tools()` this process calls to
boot one) doesn't live in this repo — it's in the real upstream
[`soketlabs/loop`](https://github.com/soketlabs/loop) project, pulled in as
an ordinary Cargo git dependency (see `Cargo.toml`):

```toml
loop-ai = { git = "https://github.com/soketlabs/loop", rev = "677556d6fb8fd7199547bad38880a975c5edb872", package = "loop-ai" }
loop-agent = { git = "https://github.com/soketlabs/loop", rev = "677556d6fb8fd7199547bad38880a975c5edb872", package = "loop-agent" }
loop-app-core = { git = "https://github.com/soketlabs/loop", rev = "677556d6fb8fd7199547bad38880a975c5edb872", package = "loop-app-core" }
```

`bootstrap`/`build_tools`/the config helpers this crate uses (`get_agent_dir`,
`trust_path`, `TrustStore`) don't live in `loop-cli` upstream — they moved
into a shared `loop-app-core` crate at some point (so both `loop-cli` and a
newer desktop app can reuse them), which is why this depends on
`loop-app-core` instead of `loop-cli`. Verified by reading upstream's
`crates/loop-app-core/src/runtime.rs` and `src/config/` directly, not
assumed from a version number.

`soketlabs/loop` is a public repo, so this needs no auth of any kind —
`cargo build` resolves it the same way it resolves any crates.io dependency,
for anyone, with zero setup. Pinned to a specific `rev` rather than tracking
a branch, deliberately: upstream evolves independently of this bridge (it's
already meaningfully ahead of the commit pinned here), and an unpinned
dependency means a routine `cargo update` could silently pull in an API
change this bridge hasn't been ported to yet. Bump the `rev` (and fix
whatever that breaks) as a deliberate choice, not an accident.

## Running it

From the repo root, easiest is the combined dev script:

```bash
./scripts/dev.sh
```

That builds and starts both this and the web frontend together, and tears
both down on Ctrl-C. To run just this piece on its own:

```bash
cargo run -p loop-server
```

## Configuration

Reads plain env vars, plus a `.env` file in the repo root if one exists (see
[`.env.example`](../.env.example) at the repo root for every option with
explanations). Quick reference:

| Var | Default | What it does |
|---|---|---|
| `LOOP_SERVER_PROVIDER` | *(unset — uses `~/.loop/agent/settings.json`)* | Which model provider to use, e.g. `ollama` for a local model |
| `LOOP_SERVER_MODEL` | *(unset)* | Which model, e.g. `qwen2.5:1.5b-instruct` |
| `LOOP_SERVER_SESSION_FILE` | `.loop-server-session-id` | Where the session id is persisted so history survives a restart |
| `LOOP_SERVER_PORT` | `8787` | Port to listen on |
| `LOOP_SERVER_CORS_ORIGIN` | `http://localhost:5173` | Only this origin may call the API — must match wherever the frontend is actually served from |

### Running against a free local model instead of a paid API

Loop defaults to Soket (needs `SOKET_API_KEY` / `TENSORSTUDIO_API_KEY` /
`LOOP_API_KEY`). To run entirely free and local instead:

1. Install [Ollama](https://ollama.com) and pull a model:
   ```bash
   ollama pull qwen2.5:1.5b-instruct
   ```
2. Register it as a custom provider in **`~/.loop/agent/models.json`**
   (note the path — `~/.loop/agent/`, *not* `~/.loop/` directly; the wrong
   path fails silently by falling back to whatever the default provider is,
   with no error, which cost real debugging time the first time around):
   ```json
   {
     "providers": [{
       "id": "ollama",
       "name": "Ollama (local)",
       "baseUrl": "http://localhost:11434/v1",
       "apiKeyEnv": [],
       "models": ["qwen2.5:1.5b-instruct"]
     }]
   }
   ```
3. Set `LOOP_SERVER_PROVIDER=ollama` and `LOOP_SERVER_MODEL=qwen2.5:1.5b-instruct`
   (in `.env`, or as real env vars).

**On model choice:** `llama3.2:1b` was also tried and handles plain chat
fine, but reliably breaks the moment tool-calling is involved — it
hallucinates malformed tool calls and dumps raw JSON schema text instead of
answering. `qwen2.5:1.5b-instruct` correctly handles both plain chat and
real tool execution; verified live against all four tools (`bash`, `read`,
`write`, `edit`). If trying a different small model, verify tool-calling
specifically before trusting it — plain chat working is not evidence tool
use will.

### Running against the real hosted model (verified working)

A second, real (non-local) option confirmed working: `https://api.tensorstudio.ai/v1`
— the same endpoint Loop's own live test suite targets (see the root
README's "Live OpenAI-compatible tests" section) — authenticates
successfully with a bearer key (ask whoever's managing access for the
current one; not written here on purpose — see the note below) and serves
several real production models, `qwen3-30b` among them (Soket's own
default test model — 30B parameters, vs. the 1.5B local one above).
Verified live: both plain chat and a real `bash` tool-call round trip
work correctly, each well under a second.

To use it, add to `~/.loop/agent/models.json`:
```json
{
  "id": "tensorstudio-litellm",
  "name": "TensorStudio (LiteLLM)",
  "baseUrl": "https://api.tensorstudio.ai/v1",
  "apiKeyEnv": ["TENSORSTUDIO_LITELLM_KEY"],
  "models": ["qwen3-30b", "llama-3.1-8b-instruct", "qwen25-7b", "gpt-oss-120b", "kimi3", "deepseek-v4-flash", "ox-alpha", "nemotron-super-free"]
}
```
Set `TENSORSTUDIO_LITELLM_KEY` (the real key value — **never commit this**,
keep it only in a local, gitignored `.env`) and
`LOOP_SERVER_PROVIDER=tensorstudio-litellm` / `LOOP_SERVER_MODEL=qwen3-30b`.

Where this key/endpoint actually comes from, who else has access, and
whether it's meant for shared/ongoing use hasn't been confirmed — treat it
as provisional until that's clarified.

## API

- `GET /health` → `{"session_id": "...", "status": "ok"}`
- `POST /prompt` with `{"text": "..."}` → an SSE stream of JSON events
  (Loop's own `AgentEvent` shape, lightly relayed — see `src/main.rs` for
  the exact set). Streams until `{"type": "stream_end"}`, then the
  connection closes.
- Returns `409 Conflict` if a turn is already in progress — this harness
  processes one turn at a time; wait for the current one to finish (or for
  `stream_end`) before sending the next `/prompt`.
- `GET /files?path=relative/dir` → `{"path": "...", "entries": [{"name", "is_dir", "size"}]}`,
  a directory listing scoped to `files_root` in `AppState` — **`/`, the
  whole filesystem, not just the project directory.** Widened from
  project-directory-only on explicit user request/confirmation (this is a
  real, deliberate change to what an unauthenticated network endpoint can
  read — not a default to restore casually). `.git`/`node_modules`/`target`
  are still filtered out of listings for noise, but that's cosmetic, not a
  boundary — nothing stops navigating into them directly or reading a file
  inside one via `/files/content`. `path` defaults to `/` when omitted.
- `GET /files/content?path=relative/file` → `{"path", "size", "content"}`
  (`content` is `null` with a `message` instead, for binary files or ones
  over the 256KB preview cap). Both endpoints still reject anything that
  canonicalizes outside `files_root` with `403`/`404` — `resolve_safe_path`
  itself is unchanged, only what root it's called with changed, so a
  `../../../etc/passwd`-style traversal attempt still gets normalized and
  checked the same way, it's just that `files_root` being `/` means
  `/etc/passwd` now legitimately resolves inside it. Terminal's shell
  (below) still opens in the harness's actual project cwd, unaffected —
  that's a separate field (`AppState.cwd`), deliberately not widened.
- `GET /terminal/ws` → upgrades to a WebSocket carrying a real, interactive
  shell in a real PTY (via `portable-pty`), spawned in the harness's cwd.
  Protocol: client sends Binary frames of raw keystroke bytes (written
  straight to the PTY) and Text frames as JSON `{"cols","rows"}` for
  resize; server sends Binary frames of raw PTY output. This is the same
  level of access the model's own `bash` tool already has — a human
  typing directly instead of the model deciding what to run — not a new
  category of risk for this bridge (see "no auth, unsandboxed" below).
  Verified two ways: a raw WebSocket client with zero UI involved (real
  shell prompt with the actual machine's hostname, real ANSI escape
  sequences, a real command's real output — see `src/main.rs`'s
  `handle_terminal_socket` for how the blocking PTY read/write is bridged
  to the async socket), and by instrumenting `WebSocket.prototype.send` in
  a live page to confirm `xterm.js`'s `onData` correctly produces a send
  for both regular keys and Enter. Driving it through actual mouse/keyboard
  browser automation to get a full screen-recorded round trip proved
  unreliable in this environment specifically — `xterm.js` reads from a
  hidden, off-screen textarea, a well-known hard case for synthetic input
  tools, unrelated to whether the feature itself works. Real typing in a
  real browser goes through none of that.
- `POST /rag/query` `{"query": "..."}` → forwards directly to the
  configured RAG service (`RAG_SERVICE_URL`/`RAG_SERVICE_API_KEY`) and
  returns its JSON response as-is. No model/harness turn involved at all —
  distinct from the `rag_query` *tool* below, which the model decides to
  call mid-conversation. This is what the frontend's `/rag-query` slash
  command hits (see `web/README.md`). Returns `503` if `RAG_SERVICE_URL`
  is unset.
- `POST /rag/ingest` `{"path": "...", "id": "optional"}` → reads a file
  already on disk (same PDF/text extraction as the `read_document` tool)
  and forwards its full text to the RAG service's own `/ingest`. What the
  frontend's `/rag-add` slash command hits. `id` defaults to the file's
  name if omitted. Returns `400` if the file doesn't exist, `503` if
  `RAG_SERVICE_URL` is unset.
- `GET /rag/documents` → list every document the RAG service has ingested
  (`{"documents": [{"doc_id", "chunks_stored", "ingested_at"}, ...]}`).
  What the frontend's `/rag-list` slash command hits.
- `GET /rag/documents/:id` → the exact original text of one ingested
  document, not a semantic search result — `{"doc_id", "text",
  "chunks_stored", "ingested_at"}`. What `/rag-add` hits. `404` if no
  document has that id.
  **Unlike every other RAG endpoint above, this pair isn't part of the
  fixed RAG interface contract** (see "Swapping in a RAG service" below) —
  most vector databases have no native "list everything" or "exact fetch
  by ID" API (pure similarity search only), so a RAG service needs its own
  separate mechanism (e.g. a small manifest alongside its vector store) to
  support these two at all. Many won't; whatever a RAG service returns for
  these (404, or nothing) is relayed as-is rather than these two pretending
  to be universal.

## Tools

Besides Loop's standard 4 tools (`read`/`write`/`edit`/`bash`, built by
`loop_app_core::runtime::build_tools` and unchanged here), this bridge registers
two more via `AgentHarness::set_tools()` at startup (see `main()` in
`src/main.rs` — the log line `registered 6 tools (4 standard +
read_document + rag_query)` confirms all six loaded). Both are real,
verified-working tools the model can choose to call, not scripted/canned
behavior:

- **`read_document`** — reads a file already on disk (a real path, not the
  chat's separate paperclip-upload attachment, which goes through the model
  differently and was already working before this) and returns its text so
  the model can summarize it or answer questions about it. Plain text files
  (`.txt`, `.md`, code, etc.) are read directly; `.pdf` files go through
  real extraction via the `pdf-extract` crate (run on a blocking thread —
  it's synchronous, CPU-bound work, not I/O). DOCX/XLSX/PPTX aren't
  supported yet and return a clear error rather than garbled bytes. Output
  over 100,000 characters is truncated with a note, to avoid blowing the
  model's context on one huge file. Verified live: a hand-built minimal PDF
  and a plain `.txt` file, both actually read via the running harness with
  a real hosted model, correctly answering questions about content that
  only exists inside the file (see git history for the exact prompts/output
  used to confirm this — not just "it compiled").
  Path resolution here is deliberately the same unrestricted access the
  model's own `bash`/`read` tools already have — this tool's actual
  value-add is the PDF text extraction, not a new access boundary; see "no
  auth, unsandboxed" above for what that access level already means.
- **`rag_query`** — queries a configurable external RAG (retrieval-augmented
  generation) service for context relevant to a question. Controlled by the
  `RAG_SERVICE_URL` / `RAG_SERVICE_API_KEY` env vars (see `.env.example`):
  unset by default — **no RAG service is bundled with this project**, and
  none is required for anything else here to work. When unset, the tool
  tells the model plainly that no RAG service is configured rather than
  fabricating retrieved content — verified live, the model relayed that
  message honestly rather than inventing an answer. The frontend also has
  four direct, non-LLM slash commands against the same configured
  service — `/rag-query`, `/rag-add`, `/rag-list`, `/rag-get` — see
  `web/README.md`.
  (An earlier version of this project bundled a real deployed test
  implementation — a small Cloudflare Worker — as a working example. It's
  been removed in favor of keeping this project provider-agnostic: connect
  whatever RAG system you actually have, rather than defaulting to one
  implementation. The interface it needs to speak is below.)

### Swapping in a RAG service

Everything above — the `rag_query` tool, `/rag/query`, `/rag/ingest` — talks
to whatever `RAG_SERVICE_URL` points at through one fixed, small interface.
None of this Rust or frontend code hardcodes anything about any specific
RAG provider — **connecting a RAG system means pointing `RAG_SERVICE_URL`
(and `RAG_SERVICE_API_KEY`, if it needs auth) at whatever implements this
interface — zero code changes here**, unless that service's actual API
differs from the shape below, in which case put a small translating
adapter in front of it rather than editing this code.

The interface, in full:

| | Request | Success response |
|---|---|---|
| `POST {RAG_SERVICE_URL}/query` | `{"query": "..."}` | any JSON — shown to the model/user as-is. `{"answer": "...", "matches": [{"score": ..., "text": ...}]}` renders nicest (see `loop-stream.ts`'s `/rag-query` handling), but any shape works — worst case it's relayed as raw JSON instead of formatted text. |
| `POST {RAG_SERVICE_URL}/ingest` | `{"text": "...", "id": "..."}` | any JSON. `{"doc_id": "...", "chunks_stored": N}` renders nicest; anything else falls back to showing the raw response. |
| Auth | `Authorization: Bearer {RAG_SERVICE_API_KEY}` sent on every request *if* that env var is set. Omit the var if the target service doesn't need auth. |

Both this crate (`build_rag_query_tool`, `rag_query_handler`,
`rag_ingest_handler` in `src/main.rs`) and the frontend (`loop-stream.ts`)
already relay whatever JSON comes back rather than requiring specific
fields — verified by reading each call site, not assumed. The only genuinely
rigid part is the *request* shape (`{"query"}` / `{"text","id"}`) — a real
RAG service that expects a different request shape needs a thin adapter
in between, not changes here.

## Known limitations / open work

- Only one turn runs at a time, process-wide (by design — see the 409
  behavior above). Fine for a single user; would need real per-session
  isolation to serve multiple concurrent users.
- Tool execution runs directly on the host, unauthenticated, with no
  sandbox and no approval step — anything reachable by `CORS_ORIGIN` can
  make the model run arbitrary shell commands on this machine. Loop itself
  supports sandboxed execution (`krun`/`podman`) and a tool-approval system;
  neither is wired up here yet. Do not expose this past `localhost` as-is.
- No auth on `/prompt`, `/files`, `/files/content`, or `/terminal/ws` at
  all — CORS origin-restriction is the only guard, and that's a
  browser-enforced convention (irrelevant to a direct `curl`/WebSocket
  client), not a real security boundary.
- `/files`/`/files/content` read anywhere on the filesystem the process's
  user can read — this is the same access level `bash`/`terminal` already
  had, just reachable through a simpler read-only HTTP GET too. Worth
  weighing specifically before deploying this anywhere reachable by more
  than yourself.
