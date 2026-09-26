import { type ChatModelFn } from "./chat";
import { failPublication } from "./errors";
import {
  CHUNKER_VERSION,
  EmbedTimeoutError,
  MAX_EMBED_ATTEMPTS,
  SEARCH_CHUNK_FIELDS,
  activeEmbeddingProfileId,
  classifyEmbedError,
  encodeSearchChunkRow,
  parseEmbedPendingChunks,
  storedEmbedding,
  storedTermIds,
  type EmbedErrorCode,
  type EmbedFn,
} from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { sameEncodedValue } from "./service.sameEncodedValue";
import { type Clock, type DatasetAdapter, type OwnerCore } from "./service.types";

/**
 * Hard bound on how long ONE embedder call may run before this worker gives
 * up and marks the whole pending batch `failed`/`embedder_timeout`. Enforced
 * by `Promise.race` (via `raceWithTimeout` below), never by trusting the
 * injected embedder to honor its own `AbortSignal` -- a test stub that never
 * resolves, and ignores the signal entirely, must still time out correctly.
 * Read at import, like `storage.ts`'s `ARRA_DATA_DIR`, so a test can set
 * `ARRA_EMBED_TIMEOUT_MS` before dynamically importing this module and never
 * has to wait out a production-sized timeout.
 */
const EMBED_CALL_TIMEOUT_MS = Number(process.env.ARRA_EMBED_TIMEOUT_MS ?? 30_000);

export type EmbedPendingChunksResult = {
  /** Rows this call examined -- bounded by `request.limit`. */
  attempted: number;
  /** Became `ready` via a fresh embedder call. */
  embedded: number;
  /** Became `ready` by copying an existing ready row's vector -- zero
   *  embedder calls for these. */
  reused: number;
  /** Transitioned to `failed` this run (embedder unavailable, timed out, or
   *  returned something this kernel would not accept). */
  failed: number;
  /** Still pending/retryable AFTER this run, workspace/chunker/active-profile
   *  scoped -- 0 means this workspace is fully caught up. */
  remaining: number;
};

/**
 * Reject with `EmbedTimeoutError` after `ms`, whichever settles first. The
 * embedder's own promise is left running (this function does not, and
 * cannot, force it to stop) -- the CALLER aborts its `AbortController`
 * afterward for a real fetch-based embedder; a hung test stub is simply
 * abandoned, which is harmless since nothing awaits it further.
 */
function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EmbedTimeoutError(`embedder call exceeded ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * #30 R8's embed worker: "index first, embed later, like backfill" made
 * real. Reads `pending` rows (and `failed` rows under `MAX_EMBED_ATTEMPTS`)
 * for the ACTIVE embedding profile, tries content-hash reuse first, calls the
 * injected embedder for the rest, and writes every outcome back.
 *
 * Ordering is the whole point (mirrors `db.ts`'s legacy `backfill`, and
 * matches `mcp-correctness.test.ts`'s already-accepted "an embedder outage
 * must not block a write" proof for that path):
 *
 * 1. READ candidates -- outside `core.serial`. A read never needs the write
 *    queue, and holding it here would serialize this worker behind every
 *    other queued mutation for no reason.
 * 2. CONTENT-HASH REUSE -- also outside `core.serial`, and BEFORE the
 *    embedder call: a row that can be satisfied by copying an existing ready
 *    vector never needs a model call at all.
 * 3. THE EMBEDDER CALL -- outside `core.serial`, wrapped in
 *    `raceWithTimeout`. This is the load-bearing property: a hanging or slow
 *    Ollama call NEVER holds the owner's serial queue, so `publishRevision`
 *    (or any other queued write) proceeds normally while this call is still
 *    in flight.
 * 4. WRITE BACK -- inside `core.serial`, one turn for the whole batch, using
 *    `writeChunkEmbedding.ts`'s own update-then-verify-readback shape.
 */
export async function embedPendingChunks(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn; embedder?: EmbedFn },
  requestBytes: Uint8Array,
): Promise<EmbedPendingChunksResult> {
  const request = parseEmbedPendingChunks(requestBytes);
  await requireContextWorkspaceRow(writer, request.workspace_name);

  const profileId = activeEmbeddingProfileId();
  const scope =
    `${contextScope(request.workspace_name)} AND chunker_version = ${quote(CHUNKER_VERSION)}` +
    ` AND embedding_profile = ${quote(profileId)}`;
  const eligibleClause = `(status = 'pending' OR (status = 'failed' AND attempts < ${MAX_EMBED_ATTEMPTS}))`;

  await writer.refresh(SEARCH_CHUNKS);
  const candidates = await writer.query(SEARCH_CHUNKS, `${scope} AND ${eligibleClause}`, request.limit);

  if (candidates.length === 0) {
    return { attempted: 0, embedded: 0, reused: 0, failed: 0, remaining: 0 };
  }

  type Plan =
    | { kind: "reuse"; row: Record<string, unknown>; embedding: number[] }
    | { kind: "embed"; row: Record<string, unknown> };
  const planned: Plan[] = [];
  const toEmbedTexts: string[] = [];
  for (const row of candidates) {
    const hash = row.content_hash;
    const id = row.id;
    if (typeof hash !== "string" || typeof id !== "string") failPublication("integrity_failure", "");
    const ready = await writer.query(
      SEARCH_CHUNKS,
      `${scope} AND content_hash = ${quote(hash)} AND status = 'ready' AND id != ${quote(id)}`,
      1,
    );
    if (ready.length > 0) {
      const embedding = storedEmbedding(ready[0]!.embedding);
      // A `ready` row's embedding is populated by construction (that is what
      // `ready` means) -- a null one here is stored corruption, not a caller
      // mistake.
      if (embedding === null) failPublication("integrity_failure", "");
      planned.push({ kind: "reuse", row, embedding });
    } else {
      planned.push({ kind: "embed", row });
      toEmbedTexts.push(row.text as string);
    }
  }

  let embeddedVectors: number[][] | null = null;
  let batchError: EmbedErrorCode | null = null;
  if (toEmbedTexts.length > 0) {
    if (options.embedder === undefined) {
      batchError = "embedder_unavailable";
    } else {
      const controller = new AbortController();
      try {
        embeddedVectors = await raceWithTimeout(
          options.embedder(toEmbedTexts, controller.signal),
          EMBED_CALL_TIMEOUT_MS,
        );
      } catch (error) {
        controller.abort();
        batchError = classifyEmbedError(error);
      }
    }
  }

  return mutateContextWrite(core, async () => {
    await core.contextBoundary("before_write", false);
    core.markAttemptedWrite();

    const now = () => BigInt(options.clock()) * 1000n;
    let embedded = 0;
    let reused = 0;
    let failedCount = 0;
    const written: Record<string, unknown>[] = [];
    let embedCursor = 0;

    for (const plan of planned) {
      const termIds = storedTermIds(plan.row.term_ids);
      let physical: Record<string, unknown>;
      if (plan.kind === "reuse") {
        physical = {
          ...plan.row,
          term_ids: termIds,
          embedding: plan.embedding,
          status: "ready",
          attempts: (plan.row.attempts as bigint) + 1n,
          last_attempt_at: now(),
          embedded_at: now(),
          error_code: null,
        };
        reused += 1;
      } else if (batchError !== null) {
        physical = {
          ...plan.row,
          term_ids: termIds,
          embedding: null,
          status: "failed",
          attempts: (plan.row.attempts as bigint) + 1n,
          last_attempt_at: now(),
          embedded_at: plan.row.embedded_at,
          error_code: batchError,
        };
        failedCount += 1;
      } else {
        const vector = embeddedVectors![embedCursor];
        embedCursor += 1;
        physical = {
          ...plan.row,
          term_ids: termIds,
          embedding: vector,
          status: "ready",
          attempts: (plan.row.attempts as bigint) + 1n,
          last_attempt_at: now(),
          embedded_at: now(),
          error_code: null,
        };
        embedded += 1;
      }
      try {
        await writer.updateSearchChunkEmbedding(physical);
      } catch {
        core.poison();
        failPublication("recovery_required", "");
      }
      written.push(physical);
    }
    await core.contextBoundary("after_write", true);

    await core.afterWrite(async () => {
      await writer.refresh(SEARCH_CHUNKS);
      for (const physical of written) {
        const rows = await writer.query(
          SEARCH_CHUNKS,
          `${contextScope(request.workspace_name)} AND id = ${quote(physical.id as string)}`,
          2,
        );
        if (rows.length !== 1) {
          core.poison();
          failPublication("recovery_required", "");
        }
        const encoded = encodeSearchChunkRow(rows[0]!);
        const expected = encodeSearchChunkRow(physical);
        for (const field of SEARCH_CHUNK_FIELDS) {
          // Same exception `writeChunkEmbedding`/`indexRevisionChunks` make:
          // `embedding` is validated inside the encode call but never on the
          // wire, so there is nothing to compare here beyond that call
          // already having succeeded.
          if (field === "embedding") continue;
          if (!sameEncodedValue(encoded[field], expected[field])) {
            core.poison();
            failPublication("recovery_required", "");
          }
        }
      }
    });
    await core.contextBoundary("after_readback", true);

    const remaining = await writer.count(SEARCH_CHUNKS, `${scope} AND ${eligibleClause}`);
    return { attempted: candidates.length, embedded, reused, failed: failedCount, remaining };
  });
}
