// Owned gated child for #30 R20's production-wiring test
// (`search-chunk-digest-boot.test.ts`). Runs INSIDE the real writer gate,
// but -- unlike `gated-embed.ts` -- injects NOTHING: it goes through
// `composition.ts` exactly as `index.ts`'s `startup()`/`buildApp()` do, so
// the embedder and the digest probe are the production ones, pointed by
// the parent at a stub Ollama through `OLLAMA_URL`.
//
//  - `payload.boot` runs `runStartupIndexWork()` first (the legacy FTS work
//    against the parent's scratch `ARRA_DATA_DIR`, plus whatever else boot
//    does -- R20 says that must never probe, pin or flip anything).
//  - `payload.ops` then run through ONE `composeKnowledgeAccess()` instance:
//    `{action, facade, method, request}`. A request string of the form
//    `"$opN.field"` is replaced by that field of op N's value, so a
//    revision id the production `randomNanoid21` minted can be indexed.
//  - `profileBefore`/`profileAfterBoot`/`profileAfter` are
//    `activeEmbeddingProfileId()` as THIS process computes it at each step.
//
// Like the other gated children it makes no assertions; it prints one JSON
// line and exits.
const [, , payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  boot?: boolean;
  ops?: Array<{ action: "content:read" | "content:write"; facade: string; method: string; request: any }>;
};

const src = (path: string) => new URL(`../../../../src/${path}`, import.meta.url).pathname;
const { composeKnowledgeAccess, runStartupIndexWork } = await import(src("composition.ts"));
const { activeEmbeddingProfileId } = await import(src("publication/search-chunk.ts"));

const results: Record<string, unknown> = { profileBefore: activeEmbeddingProfileId() };

const substitute = (value: unknown): unknown => {
  if (typeof value === "string") {
    const match = /^\$op(\d+)\.(\w+)$/.exec(value);
    if (match === null) return value;
    const prior = results[`op${match[1]}`] as { value?: Record<string, unknown> } | undefined;
    return prior?.value?.[match[2]!];
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
};

try {
  if (payload.boot === true) {
    await runStartupIndexWork();
  }
  results.profileAfterBoot = activeEmbeddingProfileId();

  const access = composeKnowledgeAccess();
  for (const [index, op] of (payload.ops ?? []).entries()) {
    try {
      const bundle = (await access.getBundle(op.action)) as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>;
      const bytes = new TextEncoder().encode(JSON.stringify(substitute(op.request)));
      results[`op${index}`] = { ok: true, value: await bundle[op.facade]![op.method]!(bytes) };
    } catch (error) {
      const e = error as { code?: unknown; toJSON?: () => unknown; message?: string };
      let envelope: unknown = null;
      try {
        envelope = typeof e.toJSON === "function" ? e.toJSON() : null;
      } catch {
        envelope = null;
      }
      results[`op${index}`] = { ok: false, code: e.code ?? null, envelope, message: e.message ?? null };
    }
  }
  results.profileAfter = activeEmbeddingProfileId();
} catch (error) {
  results.fatal = String((error as Error)?.message ?? error);
}

console.log(JSON.stringify(results));
process.exit(0);
