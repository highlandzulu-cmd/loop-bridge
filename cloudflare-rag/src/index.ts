// Minimal RAG service running entirely on Cloudflare's compute (Workers AI
// for embeddings + generation, Vectorize for the vector store) — a stand-in
// for a real RAG system until one exists, so loop-server's rag_query tool
// has something real to call. No compute happens on the laptop that deploys
// this: once `wrangler deploy` finishes, this runs on Cloudflare's edge.
//
// Endpoints:
//   GET  /health              -> { ok: true }
//   POST /ingest { text, id?} -> chunks + embeds + stores text in Vectorize,
//                                 also stores the full original text in KV
//   POST /query  { query }    -> embeds query, retrieves matches, asks the
//                                 LLM to answer using only that context
//   GET  /documents           -> list every ingested doc_id + metadata
//   GET  /documents/:id       -> the exact full text of one document
//
// /documents and /documents/:id exist because Vectorize alone has no way to
// answer either question: it's pure similarity search, no "list everything"
// API, and a metadata-filtered query still needs a query vector and is
// capped by topK, so it can't reliably return *all* chunks of one document
// either. The DOCUMENTS KV namespace stores the original full text per
// doc_id independently of Vectorize, so these two are exact lookups, not
// semantic search dressed up to look like one.
//
// All routes except /health require `Authorization: Bearer <RAG_API_KEY>`
// (set via `wrangler secret put RAG_API_KEY`) — this is a public URL on a
// free account, and Workers AI usage counts against a shared daily quota,
// so an open, unauthenticated endpoint would let anyone burn it.

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  DOCUMENTS: KVNamespace;
  RAG_API_KEY: string;
}

interface DocumentManifestEntry {
  doc_id: string;
  text: string;
  chunks_stored: number;
  ingested_at: string; // ISO 8601
}

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768-dim
// @cf/meta/llama-3.1-8b-instruct (without "-fast") was deprecated 2026-05-30
// — hit live as a 500 "Exception Thrown" the first time this was deployed.
// Confirmed current via https://developers.cloudflare.com/workers-ai/models/.
const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const CHUNK_SIZE = 800; // characters, not tokens — simple and good enough for a test stub
const CHUNK_OVERLAP = 100;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized(): Response {
  return json({ error: "missing or invalid Authorization header" }, 401);
}

function checkAuth(request: Request, env: Env): boolean {
  const header = request.headers.get("authorization") || "";
  const expected = `Bearer ${env.RAG_API_KEY}`;
  return env.RAG_API_KEY ? header === expected : false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (!checkAuth(request, env)) {
      return unauthorized();
    }

    if (url.pathname === "/ingest" && request.method === "POST") {
      const body = await request.json<{ text?: string; id?: string }>();
      if (!body.text) {
        return json({ error: "missing required 'text' field" }, 400);
      }
      const docId = body.id || crypto.randomUUID();
      const chunks = chunkText(body.text);

      // @cloudflare/workers-types unions this with an async/streamed-response
      // shape that has no `.data` — never actually returned since we don't
      // pass a streaming option, but TS can't know that, so it's asserted
      // here rather than narrowed at runtime for a case that can't happen.
      const embeddingResponse = (await env.AI.run(EMBEDDING_MODEL, {
        text: chunks,
      })) as { data: number[][] };
      const vectors = embeddingResponse.data.map((values, i) => ({
        id: `${docId}::${i}`,
        values,
        metadata: { text: chunks[i], doc_id: docId, chunk_index: i },
      }));
      await env.VECTORIZE.upsert(vectors);

      const manifestEntry: DocumentManifestEntry = {
        doc_id: docId,
        text: body.text,
        chunks_stored: chunks.length,
        ingested_at: new Date().toISOString(),
      };
      await env.DOCUMENTS.put(docId, JSON.stringify(manifestEntry));

      return json({ doc_id: docId, chunks_stored: chunks.length });
    }

    if (url.pathname === "/documents" && request.method === "GET") {
      const list = await env.DOCUMENTS.list();
      const entries = await Promise.all(
        list.keys.map(async (k) => {
          const raw = await env.DOCUMENTS.get(k.name);
          if (!raw) return null;
          const entry: DocumentManifestEntry = JSON.parse(raw);
          // Listing omits the full text (could be large across many docs) —
          // GET /documents/:id returns that.
          return { doc_id: entry.doc_id, chunks_stored: entry.chunks_stored, ingested_at: entry.ingested_at };
        }),
      );
      return json({ documents: entries.filter((e) => e !== null) });
    }

    if (url.pathname.startsWith("/documents/") && request.method === "GET") {
      const docId = decodeURIComponent(url.pathname.slice("/documents/".length));
      const raw = await env.DOCUMENTS.get(docId);
      if (!raw) {
        return json({ error: `no document with id '${docId}'` }, 404);
      }
      const entry: DocumentManifestEntry = JSON.parse(raw);
      return json(entry);
    }

    if (url.pathname === "/query" && request.method === "POST") {
      const body = await request.json<{ query?: string; top_k?: number }>();
      if (!body.query) {
        return json({ error: "missing required 'query' field" }, 400);
      }
      const topK = body.top_k ?? 4;

      const queryEmbedding = (await env.AI.run(EMBEDDING_MODEL, {
        text: [body.query],
      })) as { data: number[][] };
      const matches = await env.VECTORIZE.query(queryEmbedding.data[0], {
        topK,
        returnMetadata: true,
      });

      if (matches.matches.length === 0) {
        return json({
          answer:
            "No documents have been ingested into this RAG test stub yet, so there's nothing to retrieve. POST to /ingest first.",
          matches: [],
        });
      }

      const context = matches.matches
        .map((m, i) => `[${i + 1}] ${(m.metadata as { text?: string })?.text ?? ""}`)
        .join("\n\n");

      const completion = await env.AI.run(CHAT_MODEL, {
        messages: [
          {
            role: "system",
            content:
              "Answer the user's question using ONLY the numbered context provided. " +
              "If the context doesn't contain the answer, say so plainly instead of guessing. " +
              "Cite sources inline like [1] where relevant.",
          },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion: ${body.query}`,
          },
        ],
      });

      return json({
        answer: (completion as { response?: string }).response ?? "",
        matches: matches.matches.map((m) => ({
          score: m.score,
          text: (m.metadata as { text?: string })?.text,
        })),
      });
    }

    return json({ error: "not found" }, 404);
  },
};
