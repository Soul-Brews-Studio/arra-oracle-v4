import { CHUNKER_VERSION, activeEmbeddingProfileId, parseGetSearchFreshness } from "./search-chunk";
import { readEmbeddingPins } from "./search-chunk.readEmbeddingPins";
import { storedNullableTimestamp } from "./search-chunk.storedNullableTimestamp";
import { quote } from "./storage";
import { NODES, NODE_REVISIONS, SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { LAST_MEASURED_MODEL_DIGESTS } from "./service.lastMeasuredModelDigests";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

/** The one indexed column search-query's retrieval slice builds an FTS index
 *  over. Named here, not guessed from an index name, because `textIndexStats`
 *  itself resolves the index BY COLUMN, never by a fixed index name. */
const TEXT_INDEX_COLUMN = "text";

export type SearchFreshness = {
  content: { nodes: number; revisions: number };
  text_index: { indexed_rows: number | null; unindexed_rows: number | null };
  vectors: {
    profile_id: string;
    pending: number;
    ready: number;
    failed: number;
    last_attempt_at: string | null;
    model_digest: { pinned: string | null; last_measured: string | null };
  };
};

/**
 * #30 Revision-2 criterion: freshness per stage, with UNKNOWN kept distinct
 * from zero. Three stages, each answered from a different measurement:
 *
 * 1. Content committed: plain node/revision counts for the workspace --
 *    always knowable (the tables always exist), so 0 here is a real zero.
 * 2. Text index: `indexed_rows`/`unindexed_rows` come from
 *    `DatasetAdapter.textIndexStats`, which returns `null` when no lexical
 *    index has been built yet on `search_chunks_v1.text` -- a fact this
 *    slice does not build the index to produce (that is search-query's
 *    slice), so "no index yet" must read as unknown, not as "zero indexed".
 * 3. Vectors: pending/ready/failed counts SCOPED TO THE ACTIVE embedding
 *    profile only (R7: only the active profile is ever a target of new
 *    writes, so it is the only one freshness reports on) plus the latest
 *    `last_attempt_at` across those rows, `null` when none has ever been
 *    attempted. R20 adds `model_digest`: `pinned` is the digest this
 *    dataset pinned for the active profile (`null` until the first embed
 *    run writes a vector), `last_measured` is what the most recent embed
 *    run's probe in THIS process measured (`null` before any run here, or
 *    when that probe could not measure). The two differing is exactly the
 *    state in which embed runs refuse `embedding_profile_mismatch`.
 *    Dataset-wide, not per workspace: one pin covers the whole profile.
 */
export async function getSearchFreshness(
  reader: DatasetAdapter,
  datasetRoot: string,
  requestBytes: Uint8Array,
): Promise<SearchFreshness> {
  const request = parseGetSearchFreshness(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  const scope = contextScope(request.workspace_name);

  await reader.refresh(NODES);
  await reader.refresh(NODE_REVISIONS);
  const [nodes, revisions] = await Promise.all([
    reader.count(NODES, scope),
    reader.count(NODE_REVISIONS, scope),
  ]);

  await reader.refresh(SEARCH_CHUNKS);
  const textIndex = await reader.textIndexStats(SEARCH_CHUNKS, TEXT_INDEX_COLUMN);
  // Fix round finding 5: `textIndexStats` answers for the ONE shared
  // physical table (R7) -- LanceDB's `indexStats()` has no per-predicate
  // variant, so `indexedRows`/`unindexedRows` are never actually scoped to
  // `request.workspace_name`. Presenting them as this workspace's own
  // freshness is a cross-workspace leak (measured: a workspace with zero
  // chunks of its own reported another workspace's counts verbatim, once a
  // shared index existed). It is only safe to attribute the table-wide
  // figures to THIS workspace when this workspace demonstrably holds every
  // row currently in the table; otherwise the true per-workspace split is
  // not knowable from this API at all, and unknown stays `null` rather than
  // guessed -- the same "unknown, not zero" rule this method applies
  // everywhere else.
  let scopedTextIndex: { indexedRows: number; unindexedRows: number } | null = null;
  if (textIndex !== null) {
    const [scopedChunks, allChunks] = await Promise.all([
      reader.count(SEARCH_CHUNKS, scope),
      reader.count(SEARCH_CHUNKS, "1 = 1"),
    ]);
    if (scopedChunks === allChunks) scopedTextIndex = textIndex;
  }

  const profileId = activeEmbeddingProfileId();
  const profileScope =
    `${scope} AND chunker_version = ${quote(CHUNKER_VERSION)}` +
    ` AND embedding_profile = ${quote(profileId)}`;
  const [pending, ready, failed] = await Promise.all([
    reader.count(SEARCH_CHUNKS, `${profileScope} AND status = 'pending'`),
    reader.count(SEARCH_CHUNKS, `${profileScope} AND status = 'ready'`),
    reader.count(SEARCH_CHUNKS, `${profileScope} AND status = 'failed'`),
  ]);
  // Excluding NULLs from the predicate, rather than trusting DESC ordering to
  // put them last, sidesteps ever having to pin down this engine's NULL
  // ordering convention: zero rows here means "never attempted" unambiguously.
  const lastAttempted = await reader.orderedProjection(
    SEARCH_CHUNKS,
    `${profileScope} AND last_attempt_at IS NOT NULL`,
    ["last_attempt_at"],
    { column: "last_attempt_at", ascending: false },
    1,
  );
  const lastAttemptAt =
    lastAttempted.length === 0 ? null : storedNullableTimestamp(lastAttempted[0]!.last_attempt_at);
  const pins = readEmbeddingPins(datasetRoot);
  const modelDigest = {
    pinned: Object.hasOwn(pins, profileId) ? pins[profileId]!.digest : null,
    last_measured: LAST_MEASURED_MODEL_DIGESTS.get(datasetRoot) ?? null,
  };

  return {
    content: { nodes, revisions },
    text_index: {
      indexed_rows: scopedTextIndex === null ? null : scopedTextIndex.indexedRows,
      unindexed_rows: scopedTextIndex === null ? null : scopedTextIndex.unindexedRows,
    },
    vectors: {
      profile_id: profileId,
      pending,
      ready,
      failed,
      last_attempt_at: lastAttemptAt,
      model_digest: modelDigest,
    },
  };
}
