# The Loop Bridge

A browser-based chat UI for [Loop](README.md)'s `AgentHarness` — the same
stateful agent the `loop` TUI uses, exposed instead over HTTP/SSE/WebSocket
to a real web frontend. Built on top of Loop without modifying it: every
file under `crates/loop-agent`, `crates/loop-ai`, and `crates/loop-cli` is
untouched. Everything described here lives in three new, separate pieces —
`crates/loop-server/`, `web/`, and `cloudflare-rag/` — that consume Loop's
existing public API from the outside.

This document is the system-level overview. Each piece also has its own
much more detailed README, including the specific bugs hit and fixed along
the way, live-verification notes, and code-level rationale:

- [`crates/loop-server/README.md`](crates/loop-server/README.md) — the bridge server itself
- [`web/README.md`](web/README.md) — the chat frontend
- [`cloudflare-rag/README.md`](cloudflare-rag/README.md) — the RAG service

## What this actually is

Three cooperating pieces, each independently replaceable:

1. **`loop-server`** (Rust) — boots a real `AgentHarness` the same way the
   TUI does, then translates its internal event stream into JSON pushed to
   a browser. No thinking of its own; a pure protocol bridge.
2. **`web/`** (TypeScript, Vite, `pi-web-ui`) — the actual chat interface a
   person uses. Talks to `loop-server` over HTTP/SSE, and to nothing else
   directly.
3. **`cloudflare-rag/`** (TypeScript, Cloudflare Workers) — a small,
   real RAG (retrieval-augmented generation) service, standing in until a
   production RAG system exists. Runs entirely on Cloudflare's edge — zero
   compute on whatever machine runs `loop-server`.

## Architecture

```mermaid
flowchart TB
    subgraph Browser
        UI["web/ — chat UI<br/>(pi-web-ui + Vite)"]
    end

    subgraph Server["This machine"]
        LS["loop-server<br/>(Rust, port 8787)"]
        Harness["AgentHarness<br/>(unmodified loop-agent)"]
        Shell["Real PTY shell<br/>(portable-pty)"]
    end

    subgraph Cloud["Cloudflare (serverless)"]
        Worker["loop-rag-worker<br/>(Workers AI + Vectorize + KV)"]
    end

    LLM["LLM provider<br/>(TensorStudio / Ollama / etc.)"]

    UI <-->|"HTTP/SSE: /prompt<br/>HTTP: /files, /rag/*<br/>WebSocket: /terminal/ws"| LS
    LS --> Harness
    Harness -->|"tool calls: read/write/edit/bash,<br/>read_document, rag_query"| Harness
    Harness -->|"chat completions"| LLM
    LS -->|"real PTY, spawned in project cwd"| Shell
    LS -->|"RAG_SERVICE_URL / RAG_SERVICE_API_KEY<br/>POST /query, /ingest, GET /documents"| Worker
```

Two independent network hops leave your machine: `loop-server` → the LLM
provider (for chat), and `loop-server` → the Cloudflare Worker (for RAG).
Everything else — the terminal, file browsing, the harness itself — runs
locally.

## How the bridge actually connects the UI to the harness

This is the core problem the whole `loop-server` crate exists to solve:
**`AgentHarness` is a Rust object with a Rust API — it has no idea what a
browser, HTTP, or JSON is.** The TUI (`loop-cli`) talks to it through
direct function calls in the same process. To let a browser talk to the
same harness, something has to sit in between and translate in both
directions — that's the bridge, and it's genuinely just that: a
translation layer with no intelligence of its own. It never decides
anything, never talks to the LLM directly, never runs a tool itself — it
only relays.

### One harness, shared by every request

`loop-server` boots exactly **one** `AgentHarness` at startup, using the
same `bootstrap()` function `loop-cli` calls — not a reimplementation, the
literal same code path. That one harness instance lives for the life of
the process and is shared by every browser request.

### The event bus in the middle

The harness doesn't return one big response — internally, it emits a
stream of `AgentEvent`s as it works (`MessageStart`, text/thinking deltas
as the model generates them, `ToolExecutionStart`/`End` as it runs
`bash`/`rag_query`/etc., `MessageEnd`, and so on). `loop-server` subscribes
to that stream **exactly once**, at startup, and re-broadcasts every event
onto an internal `tokio::sync::broadcast` channel.

That one extra hop matters: subscribing to the harness fresh on every
`/prompt` request was the first approach, and it leaked — `AgentHarness`'s
`subscribe()` has no way to unsubscribe, so every request would've added a
permanent listener that outlives the request forever. Routing everything
through one shared broadcast channel instead means each request's listener
is just a cheap `Receiver`, cleaned up automatically the moment its
response ends.

### One request, start to finish

```mermaid
sequenceDiagram
    participant UI as Browser (web/)
    participant LS as loop-server
    participant H as AgentHarness
    participant LLM as LLM provider

    UI->>LS: POST /prompt {"text": "..."}
    LS->>LS: subscribe a fresh Receiver<br/>to the shared event broadcast
    LS->>H: harness.prompt(text)
    activate H
    H->>LLM: chat completion (streaming)
    LLM-->>H: token deltas
    H-->>LS: AgentEvent::MessageUpdate (via broadcast)
    LS-->>UI: SSE: data: {"type":"text_delta",...}
    Note over H: model decides to call a tool
    H->>H: execute tool for real<br/>(bash / read_document / rag_query)
    H-->>LS: AgentEvent::ToolExecutionStart/End
    H->>LLM: follow-up completion with tool result
    LLM-->>H: final response
    H-->>LS: AgentEvent::MessageEnd (stopReason != toolUse)
    deactivate H
    LS-->>UI: SSE: data: {"type":"stream_end"}
    LS->>UI: connection closes
```

Everything from `harness.prompt(text)` down happens entirely server-side,
inside one `/prompt` call — including a full tool-calling round trip
(model → tool call → real execution → model again), which can mean several
internal `MessageStart`/`MessageEnd` pairs inside one SSE stream. Only the
last one, whose `stopReason` isn't `toolUse`, is the real end of the turn;
the browser never sees the intermediate ones as separate turns.

### The other half of the bridge: reshaping the stream in the browser

Loop's event shape (`AgentEvent`) and what the chat UI library
(`pi-agent-core`) expects to receive from a normal LLM stream
(`AssistantMessageEvent`) are different protocols — Loop wraps `start`/
`done` inside `MessageStart`/`MessageEnd`, only forwarding the
delta-producing middle events as-is. `web/src/loop-stream.ts`'s
`createLoopStreamFn` is a custom `StreamFn` that reads the `/prompt` SSE
stream and re-synthesizes it into the shape `pi-agent-core` actually
expects, so the rest of the chat UI can render it exactly as if it were
talking to a real LLM API directly — it has no idea `loop-server` (or
Loop, or a bridge) exists at all. See `web/README.md` for the specific
regressions hit getting this translation exactly right.

### Terminal and Files: simpler, separate bridges

Chat needs a persistent, ordered event stream — SSE. Terminal needs
bidirectional byte-level I/O — a real WebSocket carrying a real PTY's raw
input/output (`portable-pty`), nothing translated, just relayed. Files
needs neither — plain, stateless HTTP GET per request. Three different
protocols because they're three genuinely different needs, not one
protocol stretched to fit everything.

## Features

### Chat
Real-time streaming responses over Server-Sent Events, backed by the real
`AgentHarness` — not a mock, not a scripted demo. Session state persists
server-side across restarts (`.loop-server-session-id`).

### Files
Browses the filesystem the `loop-server` process can read (by explicit
request, scoped to the whole filesystem — see "Security" below, not just
the project directory).

### Terminal
A real, interactive PTY-backed shell (`portable-pty`), streamed over a raw
WebSocket. The same level of access the model's own `bash` tool already
has — a human typing directly, not a new capability.

### Tool calling
The model has 6 real tools it can invoke on its own:

| Tool | What it does |
|---|---|
| `read`, `write`, `edit`, `bash` | Loop's standard 4 (unmodified, from `loop_cli::runtime::build_tools`) |
| `read_document` | Reads a PDF or text file already on disk, real extraction via `pdf-extract` |
| `rag_query` | Queries the configured RAG service for context |

### RAG — two ways to use it
1. **Automatic**: the model calls `rag_query`/`read_document` on its own
   whenever it decides a question needs them.
2. **Manual, instant, no LLM turn**: four slash commands, typed directly or
   picked from the `+` button's dropdown menu:

   | Command | Does |
   |---|---|
   | `/rag-query <question>` | Semantic search + generated answer |
   | `/rag-add <path>` | Ingests a file from disk into the RAG service |
   | `/rag-list` | Lists every ingested document |
   | `/rag-get <doc_id>` | Fetches one document's **exact** original text (not a search result) |

   Results from these four render visually distinct from normal chat
   replies — a purple accent border, tinted background, and an uppercase
   label (e.g. `RAG-QUERY`) — so it's obvious at a glance that an answer
   came from a direct tool call, not the model's own words.

## Getting started

```bash
# 1. Build the bridge
cargo build -p loop-server

# 2. Configure it (copy and edit)
cp .env.example .env
# at minimum: point LOOP_SERVER_PROVIDER/LOOP_SERVER_MODEL at something
# real (a hosted API, or a local Ollama — see .env.example for both), and
# optionally RAG_SERVICE_URL/RAG_SERVICE_API_KEY for RAG

# 3. Run it
./target/debug/loop-server
# → registers 6 tools, boots the harness, listens on :8787

# 4. Run the frontend, separately
cd web && npm install && npm run dev
# → opens on :5173
```

Or both together: `./scripts/dev.sh` from the repo root.

## Configuration

All of it lives in `.env` at the repo root (see `.env.example` for the full
annotated reference). The pieces most relevant to this bridge:

```bash
# Which model the harness talks to
LOOP_SERVER_PROVIDER=tensorstudio-litellm   # or "ollama" for a free local model
LOOP_SERVER_MODEL=qwen3-8-27b

# RAG service (see "The RAG system" below)
RAG_SERVICE_URL=https://loop-rag-worker.<your-subdomain>.workers.dev
RAG_SERVICE_API_KEY=<your-key>

# Networking
LOOP_SERVER_PORT=8787
LOOP_SERVER_CORS_ORIGIN=http://localhost:5173
```

## API reference

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | `{session_id, status}` |
| `POST` | `/prompt` | `{text}` → SSE stream of chat events |
| `GET` | `/files` | Directory listing |
| `GET` | `/files/content` | File contents (text preview) |
| `GET` | `/terminal/ws` | WebSocket upgrade → real PTY shell |
| `POST` | `/rag/query` | Direct RAG query, no LLM turn (`/rag-query`) |
| `POST` | `/rag/ingest` | Direct RAG ingest, no LLM turn (`/rag-add`) |
| `GET` | `/rag/documents` | List ingested documents (`/rag-list`) |
| `GET` | `/rag/documents/:id` | Exact document text (`/rag-get`) |

Full request/response shapes, status codes, and the reasoning behind each
are in [`crates/loop-server/README.md`](crates/loop-server/README.md#api).

## The RAG system

**What it is right now**: a from-scratch RAG service
([`cloudflare-rag/`](cloudflare-rag/README.md)) — real embeddings
(`@cf/baai/bge-base-en-v1.5`), a real vector database (Cloudflare
Vectorize), and real generation (`@cf/meta/llama-3.1-8b-instruct-fast`),
all running on Cloudflare Workers. Retrieval, augmentation, and generation
are all genuinely happening — it's a real RAG architecture, just a minimal
custom implementation rather than a named product. Built specifically to
require zero local or server compute, after an earlier local-Docker
attempt (self-hosted R2R) crashed the machine it ran on.

**It's a placeholder, not the destination.** The whole point of the design
below is that a real, production RAG system can be swapped in later with
minimal — ideally zero — code changes here.

### The interface contract

`loop-server` only knows about one small, fixed shape — nothing
Cloudflare-specific is hardcoded anywhere in this repo's Rust or
TypeScript:

| | Request | Response |
|---|---|---|
| `POST {RAG_SERVICE_URL}/query` | `{"query": "..."}` | any JSON (`{"answer", "matches"}` renders nicest) |
| `POST {RAG_SERVICE_URL}/ingest` | `{"text": "...", "id": "..."}` | any JSON (`{"doc_id", "chunks_stored"}` renders nicest) |

Auth: `Authorization: Bearer {RAG_SERVICE_API_KEY}` sent if that env var is
set.

**To swap in a different RAG system**: change `RAG_SERVICE_URL` /
`RAG_SERVICE_API_KEY` in `.env`. If the real system already speaks this
shape, that's the entire migration. If it doesn't (likely — this is a
convention invented for this project, not a standard), the fix is a thin
translating adapter in front of it, not editing this code.

`/rag/documents` and `/rag/documents/:id` (powering `/rag-list`/`/rag-get`)
are **not** part of this contract — they're specific to `cloudflare-rag`'s
own KV-backed manifest, since most vector databases (including Vectorize)
have no native "list everything" or "exact fetch by ID" API. A real RAG
system may not support an equivalent; those two commands simply won't work
until it does (or until an adapter fakes that layer too).
