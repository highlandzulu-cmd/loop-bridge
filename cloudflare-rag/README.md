# loop-rag-worker

A minimal, real RAG service that runs entirely on Cloudflare's compute — a
stand-in for a real RAG system until one exists, so `loop-server`'s
`rag_query` tool (see `crates/loop-server/README.md` "Tools") has something
real to call instead of getting "not configured" every time.

**Why this exists:** the first version of this test stub ran locally via
Docker (Postgres + MinIO + R2R + a local Ollama model) and it crashed the
laptop it was running on — that stack needs more RAM than an 8GB machine
has. This version does zero compute on your machine. `wrangler deploy`
uploads the code once; after that, every embed/search/generate call runs on
Cloudflare's edge, not here.

**Status: deployed and wired up.** Live at
`https://loop-rag-worker.praharshgautam.workers.dev`. `loop-server`'s
`rag_query` tool (`crates/loop-server/src/main.rs`) is pointed at it via
`RAG_SERVICE_URL`/`RAG_SERVICE_API_KEY` in `.env`, and verified end-to-end
through a real chat prompt — the model called `rag_query`, got a real
answer back from an ingested test document, and relayed it correctly. Only
that one test document is in the index right now; ingest whatever you
actually want the model to retrieve from via `POST /ingest` (see below).

**This is one interchangeable implementation, not a hardcoded dependency.**
`loop-server` only knows about a small fixed interface (`POST /query`,
`POST /ingest` — exact shape in `crates/loop-server/README.md` "Swapping in
a different RAG service"), which this Worker happens to implement. Point
`RAG_SERVICE_URL` at a real RAG system instead and this whole directory can
be deleted — zero changes needed elsewhere, as long as the real system
speaks that same interface (or sits behind a thin adapter that does).

## What it actually is

- **Embeddings**: `@cf/baai/bge-base-en-v1.5` (768-dim), via the Workers AI
  binding — Cloudflare's hosted inference for open-source models.
- **Vector store**: Cloudflare Vectorize — a managed vector database.
- **Generation**: `@cf/meta/llama-3.1-8b-instruct-fast` (the non-"-fast"
  variant was deprecated 2026-05-30 — hit live as a 500 error the first
  deploy, fixed by switching to the current model), also via Workers AI.
- **Chunking**: naive fixed-size (800 chars, 100 overlap) — good enough for
  a test stub, not tuned for real document structure.

All three (Workers AI, Vectorize, the Worker itself) have free tiers with no
card required to start. Workers AI's free tier is a daily allotment of
"neurons" (their compute-time unit) shared across all models called from
this account — plenty for manual testing, not for production traffic.

## Endpoints

- `GET /health` → `{"ok": true}`, no auth required.
- `POST /ingest` `{"text": "...", "id": "optional-doc-id"}` → chunks the
  text, embeds each chunk, stores it in Vectorize. Returns
  `{"doc_id", "chunks_stored"}`.
- `POST /query` `{"query": "...", "top_k": 4}` → embeds the query, retrieves
  the closest chunks from Vectorize, asks the LLM to answer using only that
  retrieved context (explicitly told to say so if the context doesn't
  answer the question, not to guess). Returns `{"answer", "matches"}` where
  each match has its similarity `score` and source `text`.

`/ingest` and `/query` both require `Authorization: Bearer <RAG_API_KEY>` —
this is a public URL on a free account and Workers AI usage counts against
a shared quota, so it isn't left open to anyone who finds the URL.

## One-time setup

```bash
cd cloudflare-rag
npm install
npx wrangler login          # opens your browser to authorize the CLI
npx wrangler vectorize create loop-rag-index --dimensions=768 --metric=cosine
npx wrangler secret put RAG_API_KEY   # paste a random string when prompted
npx wrangler deploy
```

`wrangler deploy` prints the live URL (`https://loop-rag-worker.<your
subdomain>.workers.dev`). That's what goes into `loop-server`'s
`RAG_SERVICE_URL` — except `rag_query` in `crates/loop-server/src/main.rs`
currently sends an unauthenticated `POST {url}/query` with no
`Authorization` header, so it needs a small update to send the bearer token
too before it'll work against this (tracked as open work below).

## Testing it directly

```bash
curl -X POST https://<your-worker-url>/ingest \
  -H "Authorization: Bearer <RAG_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "...", "id": "test-doc-1"}'

curl -X POST https://<your-worker-url>/query \
  -H "Authorization: Bearer <RAG_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query": "..."}'
```

## Known limitations / open work

- **No ingestion UI** — documents go in via a raw `curl` to `/ingest`. Fine
  for testing, not something a non-technical person would use.
- Naive fixed-size chunking, no deduplication, no per-document deletion
  endpoint, no multi-tenancy — this is a test stub, not R2R. It exists to
  give the model something real to call, not to be a production RAG system.
- Cloudflare's free tier is generous for manual testing but not unlimited —
  expect to hit daily neuron limits under heavy automated testing.
