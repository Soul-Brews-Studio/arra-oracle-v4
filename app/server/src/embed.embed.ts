// Embeddings via a local Ollama. One interface, so the provider can be swapped
// (Cloudflare Workers AI, OpenAI) without touching the table or the write path.
//
// Deliberately NOT bound into the Lance schema: rows are insertable with
// `embedding: null` and backfilled later. An embedder outage must not block a write.

export const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
// Defaults mirror migrate-py/src/arra_migrate/embeddings.py. Change both or neither.
export const MODEL = process.env.EMBEDDING_MODEL ?? "all-minilm";
export const DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? 384);

// `model` defaults to EMBEDDING_MODEL. The #30 knowledge embedders
// (`composition.ts`) pass the registry's active profile model here, so the
// profile a chunk or a semantic search reports and the model that embedded it
// are one value. `signal` lets the #30 R8 embed worker abort a call it has
// already timed out (it enforces the timeout itself; see
// `service.embedPendingChunks.ts`).
export async function embed(texts: string[], model: string = MODEL, signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { embeddings?: unknown };
  if (!Array.isArray(json.embeddings)) throw new Error("embedder returned no embeddings array");
  if (json.embeddings.length !== texts.length) {
    throw new Error(`embedder returned ${json.embeddings.length} vectors for ${texts.length} inputs`);
  }
  for (const vector of json.embeddings) {
    if (!Array.isArray(vector)) throw new Error("embedder returned a non-array vector");
    if (vector.length !== DIMS) {
      throw new Error(`embedder returned ${vector.length} dims, table expects ${DIMS}`);
    }
    if (!vector.every((value) =>
      typeof value === "number" && Number.isFinite(value) && Number.isFinite(Math.fround(value)))) {
      throw new Error("embedder returned a vector containing null, non-finite, or Float32-overflow values");
    }
  }
  return json.embeddings as number[][];
}
