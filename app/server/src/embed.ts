// Embeddings via a local Ollama. One interface, so the provider can be swapped
// (Cloudflare Workers AI, OpenAI) without touching the table or the write path.
//
// Deliberately NOT bound into the Lance schema: rows are insertable with
// `embedding: null` and backfilled later. An embedder outage must not block a write.

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
// Defaults mirror migrate-py/src/arra_migrate/embeddings.py. Change both or neither.
const MODEL = process.env.EMBEDDING_MODEL ?? "all-minilm";
export const DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? 384);

export type EmbedHealth = { ok: boolean; model: string; dims: number; detail: string };

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { embeddings: number[][] };
  const bad = json.embeddings.find((v) => v.length !== DIMS);
  if (bad) throw new Error(`embedder returned ${bad.length} dims, table expects ${DIMS}`);
  return json.embeddings;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0]!;
}

export async function health(): Promise<EmbedHealth> {
  try {
    const v = await embedOne("health");
    return { ok: true, model: MODEL, dims: v.length, detail: `${OLLAMA_URL} responding` };
  } catch (e) {
    return { ok: false, model: MODEL, dims: DIMS, detail: String(e instanceof Error ? e.message : e) };
  }
}
