// Minimal RAG service running entirely on Cloudflare's compute (Workers AI
// for embeddings + generation, Vectorize for the vector store) — a stand-in
// for a real RAG system until one exists, so loop-server's rag_query tool
// has something real to call. No compute happens on the laptop that deploys
// this: once `wrangler deploy` finishes, this runs on Cloudflare's edge.
//
// Endpoints:
//   GET  /health              -> { ok: true }
//   POST /ingest { text, id?} -> chunks + embeds + stores text in Vectorize
//   POST /query  { query }    -> embeds query, retrieves matches, asks the
//                                 LLM to answer using only that context
//
// All routes except /health require `Authorization: Bearer <RAG_API_KEY>`
// (set via `wrangler secret put RAG_API_KEY`) — this is a public URL on a
// free account, and Workers AI usage counts against a shared daily quota,
// so an open, unauthenticated endpoint would let anyone burn it.

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  RAG_API_KEY: string;
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

      const embeddingResponse = await env.AI.run(EMBEDDING_MODEL, {
        text: chunks,
      });
      const vectors = embeddingResponse.data.map((values, i) => ({
        id: `${docId}::${i}`,
        values,
        metadata: { text: chunks[i], doc_id: docId, chunk_index: i },
      }));
      await env.VECTORIZE.upsert(vectors);

      return json({ doc_id: docId, chunks_stored: chunks.length });
    }

    if (url.pathname === "/query" && request.method === "POST") {
      const body = await request.json<{ query?: string; top_k?: number }>();
      if (!body.query) {
        return json({ error: "missing required 'query' field" }, 400);
      }
      const topK = body.top_k ?? 4;

      const queryEmbedding = await env.AI.run(EMBEDDING_MODEL, {
        text: [body.query],
      });
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
