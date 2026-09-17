# loop-bridge

A browser chat UI for [Loop](https://github.com/highlandzulu-cmd/loop-harness)'s
`AgentHarness` — the same stateful agent the `loop` TUI uses, exposed
instead over HTTP/SSE/WebSocket to a web frontend. Two independent, sibling
pieces in this repo, plus the harness itself in a separate repo:

| Piece | Where | Role |
|---|---|---|
| **the harness** | separate repo: [`loop-harness`](https://github.com/highlandzulu-cmd/loop-harness) | `AgentHarness` (Rust), unmodified — the actual agent loop, tools, LLM API |
| **the bridge** | [`bridge/`](bridge/README.md) (this repo) | HTTP/SSE/WebSocket server exposing that harness to a browser |
| **the frontend** | [`web/`](web/README.md) (this repo) | The chat UI a person actually uses, talking to the bridge |

Each piece is independently runnable and independently replaceable — the
bridge only depends on the harness through its public Cargo API (a git
dependency, not a copy), and the frontend only depends on the bridge
through its HTTP API (a configurable URL, not a build-time link). See
**[`chatui.md`](chatui.md) for the full system overview** (architecture
diagram, request lifecycle, RAG integration) — this file and the two
per-piece READMEs go deeper on each one.

## How the three pieces connect

- **bridge → harness**: `bridge/Cargo.toml` depends on `loop-agent`/
  `loop-ai`/`loop-cli` as an ordinary Cargo **git dependency** against
  `loop-harness`, resolved automatically on `cargo build` — no manual
  step, no local checkout needed. See
  [`bridge/README.md`](bridge/README.md#how-this-connects-to-the-harness)
  for how that's authenticated (it's a private repo) and how to pin a
  specific version instead of tracking a branch.
- **web → bridge**: the frontend is a static site that talks to the
  bridge over plain HTTP/SSE at a configurable URL
  (`VITE_LOOP_SERVER_URL`), with the bridge's `LOOP_SERVER_CORS_ORIGIN`
  pointed back at wherever the frontend is served from. See
  [`web/README.md`](web/README.md#connecting-this-to-a-bridge) for both
  sides of that.

Nothing here requires all three pieces to live on the same machine, or in
the same repo — that's the point of splitting them this way.

## Quick start (all three, locally)

```bash
git clone https://github.com/highlandzulu-cmd/loop-bridge
cd loop-bridge
cp .env.example .env       # bridge config — at minimum pick a model provider
./scripts/dev.sh           # builds + runs bridge/ and web/ together
```

Opens on `http://localhost:5173`. `cargo build` resolves `loop-harness`
automatically as a git dependency the first time — see
[`bridge/README.md`](bridge/README.md) if that step fails (most likely
cause: no `git` access to the private `loop-harness` repo yet).

To run just one piece:

```bash
cargo run -p loop-server   # bridge only, port 8787
cd web && npm install && npm run dev   # frontend only, port 5173
```

## Just the harness (no bridge, no browser)

The harness has its own CLI and doesn't need any of this:

```bash
git clone https://github.com/highlandzulu-cmd/loop-harness
cd loop-harness
cargo run -p loop-cli
```

See that repo's README for building on top of it as a library — that's
exactly what `bridge/` does.

## Build / test (this repo)

```bash
cargo build -p loop-server
cd web && npx tsc --noEmit
```

Harness-level tests (`loop-ai`, `loop-agent`, `loop-cli`) live in and run
from the `loop-harness` repo, not here.
