/**
 * Trusted startup index work.
 *
 * Lives here, not in the HTTP entrypoint: §3 keeps index/app free of raw store
 * imports, and startup maintenance is an operator path, not a request path.
 *
 * #30 R20: boot never probes the embedding model, never pins its digest and
 * never changes an embedding profile id. The digest is measured by every
 * `embedPendingChunks` run instead (`search-chunk-digest-boot.test.ts` runs
 * this function against a live stub Ollama and asserts zero requests).
 */
export async function runStartupIndexWork(): Promise<void> {
  const store = await import("./db");
  // Do not rebuild a matching index on every restart, and never mutate on read.
  // An index whose live details differ from the shared trigram config (an older
  // deployment's icu) is rebuilt here once, before listen (R14, #10).
  await store.ensureFtsIndex(false);
}
