# loop-bridge

A browser chat UI for [Loop](https://github.com/soketlabs/loop)'s
`AgentHarness` — the same stateful agent the `loop` TUI uses, exposed
instead over HTTP/SSE/WebSocket to a web frontend. Two independent, sibling
pieces in this repo, plus the real upstream harness project:

| Piece | Where | Role |
|---|---|---|
| **the harness** | upstream: [`soketlabs/loop`](https://github.com/soketlabs/loop) | `AgentHarness` (Rust), unmodified — the actual agent loop, tools, LLM API |
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
  `loop-ai`/`loop-app-core` as an ordinary Cargo **git dependency** against
  the public [`soketlabs/loop`](https://github.com/soketlabs/loop) repo,
  pinned to a specific commit, resolved automatically on `cargo build` —
  no manual step, no auth, no local checkout needed, since it's a public
  repo. See
  [`bridge/README.md`](bridge/README.md#how-this-connects-to-the-harness)
  for exactly which crates/functions it uses and why it's pinned rather
  than tracking a branch.
- **web → bridge**: the frontend is a static site that talks to the
  bridge over plain HTTP/SSE at a configurable URL
  (`VITE_LOOP_SERVER_URL`), with the bridge's `LOOP_SERVER_CORS_ORIGIN`
  pointed back at wherever the frontend is served from. See
  [`web/README.md`](web/README.md#connecting-this-to-a-bridge) for both
  sides of that.

Nothing here requires all three pieces to live on the same machine, or in
the same repo — that's the point of splitting them this way. And since the
harness dependency is a public repo, none of this requires access to be
granted to anyone — clone this repo and `cargo build` just works.

## Quick start (all three, locally)

```bash
git clone https://github.com/highlandzulu-cmd/loop-chat-bridge
cd loop-chat-bridge
cp .env.example .env       # bridge config — at minimum pick a model provider
./scripts/dev.sh           # builds + runs bridge/ and web/ together
```

Opens on `http://localhost:5173`. `cargo build` resolves the harness
dependency automatically the first time, same as any other Cargo
dependency — no credentials, no extra setup.

To run just one piece:

```bash
cargo run -p loop-server   # bridge only, port 8787
cd web && npm install && npm run dev   # frontend only, port 5173
```

## Just the harness (no bridge, no browser)

The harness has its own CLI and doesn't need any of this:

```bash
git clone https://github.com/soketlabs/loop
cd loop
cargo run -p loop-cli
```

See that repo's README for building on top of it as a library — that's
exactly what `bridge/` does.

## Build / test (this repo)

```bash
cargo build -p loop-server
cd web && npx tsc --noEmit
```

Harness-level tests (`loop-ai`, `loop-agent`, `loop-app-core`) live in and
run from the `soketlabs/loop` repo, not here.
