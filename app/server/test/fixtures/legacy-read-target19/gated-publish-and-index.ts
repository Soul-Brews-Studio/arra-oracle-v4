// Owned fault-test child for R33 S2 (`legacy-read-target19-parity.test.ts`):
// publishes one revision, then chunk-indexes it (PENDING) the same way
// `migration/deriveProjections.ts` does, so the #30 R14 ngram FTS index has
// something to find. No embedding: `db.searchText` never reads a vector,
// only `db.searchVector`, which this test does not exercise against a real
// index (a stub embedder would need to be composed on the search side too).
import { readArgPayload } from "../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  request: unknown;
  revisionIds: string[];
  clockMs: number;
};

const { openEvidenceWriter } = await import(new URL("../../../src/publication/service.ts", import.meta.url).pathname);
const { activeEmbeddingProfileId } = await import(
  new URL("../../../src/publication/search-chunk.activeEmbeddingProfileId.ts", import.meta.url).pathname
);
const { EMBEDDING_DIMENSION } = await import(
  new URL("../../../src/publication/search-chunk.profiles.ts", import.meta.url).pathname
);
const { CHUNKER_VERSION } = await import(
  new URL("../../../src/publication/search-chunk.chunkerVersion.ts", import.meta.url).pathname
);

let index = 0;
const bundle = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[index++] ?? `fallback${String(index).padStart(15, "0")}`,
  clock: () => payload.clockMs,
  env: process.env,
  sourceNamespace: null,
});

try {
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  const outcome = await bundle.publication.publishRevision(bytes(payload.request));
  const content = (payload.request as { content: { workspace_name: string; node_id: string } }).content;
  const revisionId = payload.revisionIds[0]!;
  const indexed = await bundle.context.indexRevisionChunks(
    bytes({
      workspace_name: content.workspace_name,
      node_id: content.node_id,
      revision_id: revisionId,
      chunker_version: CHUNKER_VERSION,
      embedding_profile: { name: activeEmbeddingProfileId(), dims: EMBEDDING_DIMENSION },
    }),
  );
  console.log(JSON.stringify({ ok: true, outcome, indexed }));
} catch (error) {
  const e = error as { code?: string; path?: string; message?: string };
  console.log(JSON.stringify({ ok: false, code: e.code ?? null, path: e.path ?? null, message: e.message ?? String(error) }));
} finally {
  await bundle.close();
}
