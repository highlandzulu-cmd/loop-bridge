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
renderer for the event stream. See [`../../web/README.md`](../../web/README.md)
for the frontend side of this.

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
[`.env.example`](../../.env.example) at the repo root for every option with
explanations). Quick reference:

| Var | Default | What it does |
|---|---|---|
| `LOOP_SERVER_PROVIDER` | *(unset — uses `~/.loop/agent/settings.json`)* | Which model provider to use, e.g. `ollama` for a local model |
| `LOOP_SERVER_MODEL` | *(unset)* | Which model, e.g. `qwen2.5:1.5b-instruct` |
| `LOOP_SERVER_SESSION_FILE` | `.loop-server-session-id` | Where the session id is persisted so history survives a restart |
| `LOOP_SERVER_PORT` | `8787` | Port to listen on |
| `LOOP_SERVER_CORS_ORIGIN` | `http://localhost:5173` | Only this origin may call the API — must match wherever the frontend is actually served from |
| `LOOP_SERVER_FAUX` | `0` | Set to `1` to use Loop's built-in scripted provider instead of a real model — for testing the bridge/frontend wiring itself without needing a model at all |

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
  a directory listing scoped to the harness's cwd (the project directory).
  `.git`/`node_modules`/`target` are filtered out. `path` defaults to the
  root when omitted.
- `GET /files/content?path=relative/file` → `{"path", "size", "content"}`
  (`content` is `null` with a `message` instead, for binary files or ones
  over the 256KB preview cap). Both endpoints reject anything that
  canonicalizes outside the project root with `403`/`404` — verified live,
  including with a `../../../etc/passwd`-style traversal attempt and a
  bare absolute path, both correctly blocked.

## Known limitations / open work

- Only one turn runs at a time, process-wide (by design — see the 409
  behavior above). Fine for a single user; would need real per-session
  isolation to serve multiple concurrent users.
- Tool execution runs directly on the host, unauthenticated, with no
  sandbox and no approval step — anything reachable by `CORS_ORIGIN` can
  make the model run arbitrary shell commands on this machine. Loop itself
  supports sandboxed execution (`krun`/`podman`) and a tool-approval system;
  neither is wired up here yet. Do not expose this past `localhost` as-is.
- No auth on `/prompt` at all — CORS origin-restriction is the only guard,
  and that's a browser-enforced convention, not a real security boundary.
