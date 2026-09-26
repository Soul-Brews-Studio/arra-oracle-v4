// Owned test child for #30 / #10 keyword score isolation (overnight R21,
// docs/overnight/DECISIONS.md). Runs INSIDE the real writer gate so the
// shared `search_chunks_v1` FTS index carries real, corpus-wide BM25
// statistics -- the thing the raw `score` field leaked.
//
// Every op runs sequentially against the SAME writer/reader pair, in the
// exact order the test built them: one ALPHA node is published and indexed,
// then searched (`kw_before`); several BETA nodes repeating the same term
// are published and indexed (shifting the shared index's document frequency
// for it, never ALPHA's own rows); ALPHA is searched again with the
// IDENTICAL request (`kw_after`). Nothing here touches an embedder --
// keyword search never uses one.
import { readArgPayload } from "../../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  ops: Array<{ label: string; facade: "publication" | "context" | "reader"; method: string; request?: unknown }>;
  revisionIds: string[];
};

const src = (file: string) => new URL(`../../../../src/${file}`, import.meta.url).pathname;
const { openEvidenceReader, openEvidenceWriter } = await import(src("publication/service.ts"));

let revisionIndex = 0;
const writer = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(13, "0")}`,
  clock: () => 1_758_412_800_000,
  sourceNamespace: null,
});
const reader = await openEvidenceReader(datasetRoot!, {});

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; message?: string };
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, message: e.message ?? null };
};

const results: Record<string, unknown> = {};
for (const op of payload.ops) {
  try {
    const bundle = op.facade === "reader" ? reader.context : (writer as Record<string, any>)[op.facade];
    const call = bundle?.[op.method];
    if (typeof call !== "function") {
      results[op.label] = { ok: false, code: "no_such_method" };
      continue;
    }
    const value = await call(new TextEncoder().encode(JSON.stringify(op.request)));
    results[op.label] = { ok: true, value };
  } catch (error) {
    results[op.label] = { ok: false, ...describeError(error) };
  }
}

console.log(JSON.stringify(results));
await writer.close();
