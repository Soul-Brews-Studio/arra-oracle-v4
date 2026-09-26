import { failPublication } from "./errors";
import { encodeSearchChunkRow, parseWriteChunkEmbedding, SEARCH_CHUNK_FIELDS, storedTermIds } from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { sameEncodedValue } from "./service.sameEncodedValue";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

/**
 * #90: the embed step `search-chunk.ts`'s header and `storedStatus`'s own
 * comment both describe as "not-yet-implemented" -- the real write path for
 * a POPULATED `embedding`. Attaches a caller-supplied vector to an already
 * `indexRevisionChunks`-created `pending` row, transitioning it to `ready`.
 *
 * This invents no embedding MODEL and makes no network call: the vector
 * arrives as request data, exactly like every other physical column this
 * kernel writes. Computing it is somebody else's job.
 *
 * UPDATE, never append: `search_chunks_v1.id` is this table's whole
 * idempotency mechanism (`deriveChunkId`'s doc) -- a second `append` at an
 * existing id would create a duplicate row `contextOne` could no longer
 * resolve as unique. The real writer machinery for that is
 * `updateSearchChunkEmbedding`'s merge-insert, which can only UPDATE a row
 * already matching on `id` and can never insert one -- so this can never
 * conjure a chunk `indexRevisionChunks` did not first create.
 */
export function writeChunkEmbedding(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock; sourceNamespace: string | null },
  requestBytes: Uint8Array,
) {
  const request = parseWriteChunkEmbedding(requestBytes);
  return mutateContextWrite(core, async () => {
    await requireContextWorkspaceRow(writer, request.workspace_name);
    await writer.refresh(SEARCH_CHUNKS);
    const scope = `${contextScope(request.workspace_name)} AND id = ${quote(request.id)}`;
    const existing = await contextOne(writer, SEARCH_CHUNKS, scope);
    if (existing === null) failPublication("invalid_reference", "/id");
    // Only a `pending` row can be embedded here. A `ready` row already
    // carries a vector; re-embedding it would silently discard the previous
    // one instead of going through whatever `ready -> ready` reconciliation
    // is supposed to mean, which this method does not implement. A `failed`
    // row is likewise left to whatever retry path owns that transition.
    if (existing.status !== "pending") failPublication("invalid_reference", "/id");

    const nowMicros = BigInt(options.clock()) * 1000n;
    // Every OTHER physical column carries over from the row
    // `indexRevisionChunks` already wrote and verified; only the embed-step
    // columns change here.
    const physical: Record<string, unknown> = {
      ...existing,
      embedding: request.embedding,
      // Raw reads hand this column back as an Arrow Vector (MEASURED, see
      // `storedTermIds`), not the plain array the Arrow builder needs to
      // rebuild the row.
      term_ids: storedTermIds(existing.term_ids),
      status: "ready",
      attempts: (existing.attempts as bigint) + 1n,
      last_attempt_at: nowMicros,
      embedded_at: nowMicros,
      error_code: null,
    };

    await core.contextBoundary("before_write", false);
    core.markAttemptedWrite();
    try {
      await writer.updateSearchChunkEmbedding(physical);
    } catch {
      core.poison();
      failPublication("recovery_required", "");
    }
    await core.contextBoundary("after_write", true);

    const stored = await core.afterWrite(async () => {
      await writer.refresh(SEARCH_CHUNKS);
      const row = await contextOne(writer, SEARCH_CHUNKS, scope);
      if (row === null) {
        core.poison();
        failPublication("recovery_required", "");
      }
      const encoded = encodeSearchChunkRow(row);
      // COMPARE every non-embedding physical field against what was asked
      // for, exactly like `indexRevisionChunks`'s own readback. `embedding`
      // is validated inside `encodeSearchChunkRow` but never appears in its
      // returned wire object, so there is nothing to compare here beyond the
      // encode call already having succeeded -- the actual populated-vector
      // proof is the raw-row assertion in the precision test, not this
      // wire-field loop.
      const expected = encodeSearchChunkRow(physical);
      for (const field of SEARCH_CHUNK_FIELDS) {
        if (field === "embedding") continue;
        if (!sameEncodedValue(encoded[field], expected[field])) {
          core.poison();
          failPublication("recovery_required", "");
        }
      }
      return encoded;
    });
    await core.contextBoundary("after_readback", true);
    return { outcome: "embedded" as const, row: stored };
  });
}
