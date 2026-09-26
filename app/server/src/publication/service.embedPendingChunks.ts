import { failPublication } from "./errors";
import {
  CHUNKER_VERSION,
  EMBEDDING_DIMENSION,
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
import { failEmbeddingProfileMismatch } from "./search-chunk.failEmbeddingProfileMismatch";
import { readEmbeddingPins } from "./search-chunk.readEmbeddingPins";
import { type DigestProbeFn } from "./search-chunk.types";
import { writeEmbeddingPin } from "./search-chunk.writeEmbeddingPin";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { measureModelDigest } from "./service.measureModelDigest";
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
 *
 * Fix round: guarded against `Number(undefined) === NaN` being the ONLY
 * previous safety net -- an env var set to the empty string reads as
 * `Number("") === 0`, which timed out every embedder call before it could
 * ever leave the process. Anything that is not a finite positive number
 * falls back to the 30s default instead.
 */
const EMBED_CALL_TIMEOUT_MS = ((): number => {
  const raw = Number(process.env.ARRA_EMBED_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

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
  /** Fix round: rows this call planned to write but did NOT, because their
   *  stored `(status, attempts)` had already moved by the time this call's
   *  turn on `core.serial` ran -- a concurrent `writeChunkEmbedding` (or
   *  another `embedPendingChunks` run) got there first while THIS call's
   *  embedder request was still in flight, outside the queue. Never
   *  overwritten; simply left as whatever the winning writer left them at.
   *  0 in the overwhelming common case of no contention. */
  skipped: number;
  /** R20: `"digest_unmeasured"` when this run embedded and wrote NOTHING
   *  because no single measured model digest covers it -- the probe failed,
   *  timed out or answered nothing recognisable (before the embedder), or
   *  answered differently after it. Rows are left exactly as they were:
   *  not failed, `attempts` untouched. `null` on every other outcome. */
  blocked: "digest_unmeasured" | null;
};

/** The digest this dataset pinned for `profileId` (R20), or `null` when
 *  nothing is pinned yet. A damaged pin file is `integrity_failure`. */
function pinnedDigest(datasetRoot: string, profileId: string): string | null {
  const pins = readEmbeddingPins(datasetRoot);
  return Object.hasOwn(pins, profileId) ? pins[profileId]!.digest : null;
}

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
 * Fix round finding 2: the embedder's response was previously trusted
 * blind -- indexed into positionally and written straight into a
 * `fixed_size_list<float32>[384]` column with no shape or value check of
 * its own. `embed.ts`'s OWN validation is not a substitute: it checks
 * against `process.env.EMBEDDING_DIMENSIONS` (configurable, defaults to
 * 384), not this registry's FROZEN `EMBEDDING_DIMENSION` -- an operator
 * misconfiguring that env var (or a swapped-in embedder module that skips
 * its own check entirely) must not be able to reach
 * `service.makeAdapter.ts`'s hand-built Arrow buffer with a wrong-length or
 * non-finite vector, which throws `integrity_failure` deep inside a shared
 * `core.serial` turn and poisons the writer for every OTHER queued caller
 * (measured: a short batch or a NaN vector each turned an unrelated,
 * concurrent `publishRevision` into `{code: 'recovery_required'}`). Any
 * out-of-contract shape here becomes `embedder_bad_response` for the WHOLE
 * batch instead -- a normal, closed, per-row `failed` outcome, never a
 * write attempt.
 */
function isValidEmbeddingBatch(value: unknown, expectedCount: number): value is number[][] {
  if (!Array.isArray(value) || value.length !== expectedCount) return false;
  return value.every(
    (vector) =>
      Array.isArray(vector) &&
      vector.length === EMBEDDING_DIMENSION &&
      vector.every((component) => typeof component === "number" && Number.isFinite(component)),
  );
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
 *
 * R20 (docs/overnight/DECISIONS.md) gates all four steps on the model
 * digest, which is part of the profile's identity:
 *
 * - Step 0, before ANYTHING else, on EVERY run: probe the serving model's
 *   digest (`measureModelDigest`, bounded). Unmeasurable -> return
 *   `blocked: "digest_unmeasured"` having embedded and written nothing.
 *   Measured but different from this dataset's pin ->
 *   `embedding_profile_mismatch` naming both, nothing embedded or written.
 * - After the embedder call, probe again: vectors are only written when the
 *   SAME digest was measured on both sides of the call that produced them;
 *   anything else is `digest_unmeasured`, nothing written.
 * - Inside the write turn: re-read the pin (another run may have pinned
 *   since step 0), and, when nothing is pinned yet and this turn is about to
 *   write its first vector, pin the measured digest first. A pin is only
 *   ever written by a run that writes a vector, from that run's own
 *   measurement. `profile_id` itself never changes (search-chunk.profiles.ts).
 */
export async function embedPendingChunks(
  writer: DatasetAdapter,
  core: OwnerCore,
  options: {
    clock: Clock;
    sourceNamespace: string | null;
    documentEmbedder?: EmbedFn;
    digestProbe?: DigestProbeFn;
    datasetRoot: string;
  },
  requestBytes: Uint8Array,
): Promise<EmbedPendingChunksResult> {
  const request = parseEmbedPendingChunks(requestBytes);
  await requireContextWorkspaceRow(writer, request.workspace_name);

  const profileId = activeEmbeddingProfileId();
  const scope =
    `${contextScope(request.workspace_name)} AND chunker_version = ${quote(CHUNKER_VERSION)}` +
    ` AND embedding_profile = ${quote(profileId)}`;
  const eligibleClause = `(status = 'pending' OR (status = 'failed' AND attempts < ${MAX_EMBED_ATTEMPTS}))`;
  const blocked = async (): Promise<EmbedPendingChunksResult> => {
    await writer.refresh(SEARCH_CHUNKS);
    const remaining = await writer.count(SEARCH_CHUNKS, `${scope} AND ${eligibleClause}`);
    return { attempted: 0, embedded: 0, reused: 0, failed: 0, remaining, skipped: 0, blocked: "digest_unmeasured" };
  };

  // R20 step 0: measure first, compare with the pin, before any read of work.
  const measured = await measureModelDigest(options.datasetRoot, options.digestProbe);
  if (measured === null) return blocked();
  const pinnedAtStart = pinnedDigest(options.datasetRoot, profileId);
  if (pinnedAtStart !== null && pinnedAtStart !== measured) failEmbeddingProfileMismatch(pinnedAtStart, measured);

  await writer.refresh(SEARCH_CHUNKS);
  const candidates = await writer.query(SEARCH_CHUNKS, `${scope} AND ${eligibleClause}`, request.limit);

  if (candidates.length === 0) {
    return { attempted: 0, embedded: 0, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null };
  }

  type Plan =
    | { kind: "reuse"; row: Record<string, unknown>; embedding: number[] }
    | { kind: "embed"; row: Record<string, unknown>; embedding: number[] | null };
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
      planned.push({ kind: "embed", row, embedding: null });
      toEmbedTexts.push(row.text as string);
    }
  }

  let embeddedVectors: number[][] | null = null;
  let batchError: EmbedErrorCode | null = null;
  if (toEmbedTexts.length > 0) {
    if (options.documentEmbedder === undefined) {
      batchError = "embedder_unavailable";
    } else {
      const controller = new AbortController();
      try {
        const vectors = await raceWithTimeout(
          options.documentEmbedder(toEmbedTexts, controller.signal),
          EMBED_CALL_TIMEOUT_MS,
        );
        if (isValidEmbeddingBatch(vectors, toEmbedTexts.length)) {
          embeddedVectors = vectors;
          // Assigned by POSITION, once, here -- never via a running cursor
          // inside the write loop below, which would go out of sync the
          // moment that loop skips a stale plan (fix round finding 3) and
          // hand a later "embed" plan the WRONG vector.
          let cursor = 0;
          for (const plan of planned) {
            if (plan.kind === "embed") {
              plan.embedding = vectors[cursor]!;
              cursor += 1;
            }
          }
        } else {
          // Out-of-contract response: wrong count, wrong-length vector(s),
          // or a non-finite component. Never partially trusted -- see
          // `isValidEmbeddingBatch`'s doc.
          batchError = "embedder_bad_response";
        }
      } catch (error) {
        controller.abort();
        batchError = classifyEmbedError(error);
      }
    }
  }

  // R20: the model that answered the embedder call must be the one measured
  // before it. A second probe is the only way to know; any other answer
  // (a changed build, or none) means no single digest covers these vectors.
  if (embeddedVectors !== null) {
    const confirmed = await measureModelDigest(options.datasetRoot, options.digestProbe);
    if (confirmed !== measured) return blocked();
  }

  return mutateContextWrite(core, async () => {
    await core.contextBoundary("before_write", false);

    // Fix round finding 3: refresh right before the per-row current-state
    // check below, matching `writeChunkEmbedding.ts`'s own convention.
    await writer.refresh(SEARCH_CHUNKS);

    // R20, re-checked inside the turn: a concurrent run may have pinned a
    // digest since step 0. Still before any write, so refusing here leaves
    // the owner usable.
    const pinned = pinnedDigest(options.datasetRoot, profileId);
    if (pinned !== null && pinned !== measured) failEmbeddingProfileMismatch(pinned, measured);

    const now = () => BigInt(options.clock()) * 1000n;
    let embedded = 0;
    let reused = 0;
    let failedCount = 0;
    let skipped = 0;
    const written: Record<string, unknown>[] = [];
    const current: Plan[] = [];

    for (const plan of planned) {
      // Fix round finding 3 ("lost acknowledged write"): `plan.row` was read
      // BEFORE the (possibly slow, possibly-timed-out) embedder call above,
      // entirely outside this `core.serial` turn -- a concurrent
      // `writeChunkEmbedding` or another `embedPendingChunks` run can
      // complete its OWN turn in that window and move this exact row to a
      // state this plan knows nothing about. `attempts` is this table's own
      // monotonically-increasing write counter (every transition here and
      // in `writeChunkEmbedding` increments it), so "attempts AND status
      // both still match what this plan read" is exactly "nobody else has
      // touched this row since this call read it". A mismatch means
      // somebody else already won that race; their write is never
      // clobbered by this batch's stale plan -- this row is simply skipped,
      // left exactly as the winning writer left it.
      const id = plan.row.id as string;
      const stored = await writer.query(
        SEARCH_CHUNKS,
        `${contextScope(request.workspace_name)} AND id = ${quote(id)}`,
        1,
      );
      if (
        stored.length !== 1 ||
        stored[0]!.attempts !== plan.row.attempts ||
        stored[0]!.status !== plan.row.status
      ) {
        skipped += 1;
        continue;
      }
      current.push(plan);
    }

    // R20 (1): the first vector this dataset ever gets under this profile is
    // preceded by its pin, from THIS run's measurement. A run that writes no
    // vector (every row failed or skipped) pins nothing.
    const writesVector = current.some((plan) => plan.kind === "reuse" || batchError === null);
    if (pinned === null && writesVector) {
      writeEmbeddingPin(options.datasetRoot, profileId, measured, options.clock());
    }

    core.markAttemptedWrite();
    for (const plan of current) {
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
        // Assigned by position, before this turn even started -- see the
        // comment where `plan.embedding` is set, above.
        if (plan.embedding === null) failPublication("integrity_failure", "");
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
    return { attempted: candidates.length, embedded, reused, failed: failedCount, remaining, skipped, blocked: null };
  });
}
