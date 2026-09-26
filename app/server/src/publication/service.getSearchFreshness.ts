import { CHUNKER_VERSION, activeEmbeddingProfileId, parseGetSearchFreshness } from "./search-chunk";
import { storedNullableTimestamp } from "./search-chunk.storedNullableTimestamp";
import { quote } from "./storage";
import { NODES, NODE_REVISIONS, SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
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
 *    attempted.
 */
export async function getSearchFreshness(
  reader: DatasetAdapter,
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

  return {
    content: { nodes, revisions },
    text_index: {
      indexed_rows: textIndex === null ? null : textIndex.indexedRows,
      unindexed_rows: textIndex === null ? null : textIndex.unindexedRows,
    },
    vectors: { profile_id: profileId, pending, ready, failed, last_attempt_at: lastAttemptAt },
  };
}
