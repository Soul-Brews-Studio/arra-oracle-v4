import { fail } from "../contracts/errors";
import { FTS_CANDIDATE_CEILING, overfetchCoverage } from "../fts/fts";
import { CHUNKER_VERSION, activeEmbeddingProfileId, coverageSignal, groupKnowledgeHits, parseSearchKnowledgeSemantic, rankedChunk } from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { currentEligibleChunks } from "./service.currentEligibleChunks";
import { embedSearchQuery } from "./service.embedSearchQuery";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter, type QueryEmbedder } from "./service.types";

/**
 * #30 semantic retrieval over the target-19 knowledge tier (overnight R7 #30
 * part): the nodes whose CURRENT, recall-eligible head revision has a READY
 * chunk vector nearest the query's, under ONE embedding profile.
 *
 * - The query is embedded by the injected `embedder` (composition: `embed.ts`
 *   over local Ollama; tests: a stub). A request naming no profile reads the
 *   embedder's own (the #30 registry's active profile id,
 *   `activeEmbeddingProfileId()`, only when none is composed, which then
 *   answers the closed `model_unavailable` code anyway -- overnight R21,
 *   aligned with #32 / R9's chat code). A profile the embedder does not
 *   serve is refused (`invalid_value` at `/embedding_profile`) BEFORE any
 *   model call: comparing one model's query vector with another model's
 *   stored vectors answers nothing meaningful, so vector spaces are never
 *   mixed.
 * - Candidates are `status = 'ready'` chunks of that profile and the one
 *   implemented chunker, nearest first by LanceDB `l2`, which is the SQUARED
 *   Euclidean distance -- reported as stored (`metric: "l2_squared"`).
 *   Pending and failed chunks have no vector and are never candidates.
 * - Same answer discipline as keyword search: chunks of the head revision of
 *   recall-eligible nodes only (`currentEligibleChunks`), one hit per node at
 *   its nearest chunk, workspace-scoped reads, ordered by distance then node
 *   id, bounded by the shared overfetch loop. Never fused with keyword (R7).
 *   Unlike keyword's `rank` (R21), `distance` stays a raw number: it is the L2
 *   distance between the query vector and one stored row's OWN vector, a
 *   per-row quantity, never a corpus-wide statistic like BM25's document
 *   frequency, so it carries no cross-workspace leak.
 * - COVERAGE (#30, `search-chunk-v1.md` section 21): the overfetch loop's
 *   own bound. When its last round read the whole `ceiling` of nearest
 *   chunks and fewer than `limit` nodes survived (stale revisions, retired
 *   nodes, several chunks of one node), a farther match may exist unread:
 *   `coverage: "partial"`, `coverage_reason: "candidate_ceiling"`. An answer
 *   that reached `limit`, or whose source ran dry, is `"full"`. The read is
 *   prefiltered to the workspace, so the flag is workspace-local. `ceiling`
 *   is `FTS_CANDIDATE_CEILING`; only tests inject another.
 */
export async function searchKnowledgeSemantic(
  reader: DatasetAdapter,
  embedder: QueryEmbedder | undefined,
  requestBytes: Uint8Array,
  requestTimeMs?: number,
  ceiling: number = FTS_CANDIDATE_CEILING,
) {
  const request = parseSearchKnowledgeSemantic(requestBytes);
  await requireWorkspace(reader, request.workspace_name);
  // The composed embedder's own profile; production composes it with the #30
  // registry's active id (`composition.ts`), the id every chunk row is
  // indexed under, so a default search reads exactly the active profile.
  const profile = request.embedding_profile ?? embedder?.profile ?? activeEmbeddingProfileId();
  if (embedder !== undefined && profile !== embedder.profile) {
    fail("invalid_value", ["embedding_profile"], "no query embedder serves this embedding profile");
  }
  const vector = await embedSearchQuery(embedder, request.query);

  await reader.refresh(SEARCH_CHUNKS);
  const predicate =
    `${contextScope(request.workspace_name)} AND status = 'ready'` +
    ` AND embedding_profile = ${quote(profile)}` +
    ` AND chunker_version = ${quote(CHUNKER_VERSION)}`;

  const current = currentEligibleChunks(reader, request.workspace_name, null, requestTimeMs);
  const { kept: hits, saturated } = await overfetchCoverage(
    request.limit,
    async (fetch) => {
      const candidates = await reader.vectorSearchChunks(vector, predicate, fetch);
      const kept = await current(candidates.map((row) => rankedChunk(row, row._distance)));
      return { fetched: candidates.length, kept: groupKnowledgeHits(kept.chunks, kept.heads, "ascending", null) };
    },
    ceiling,
  );

  return {
    embedding_profile: profile,
    metric: "l2_squared" as const,
    ...coverageSignal(saturated, ceiling),
    hits: hits.map((hit) => ({
      node_id: hit.node_id,
      revision_id: hit.revision_id,
      title: hit.title,
      snippet: hit.snippet,
      chunk_ids: hit.chunk_ids,
      distance: hit.rank,
    })),
  };
}
