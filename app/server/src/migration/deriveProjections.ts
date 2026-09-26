import { activeEmbeddingProfileId } from "../publication/search-chunk.activeEmbeddingProfileId";
import { CHUNKER_VERSION } from "../publication/search-chunk.chunkerVersion";
import { EMBEDDING_DIMENSION } from "../publication/search-chunk.profiles";
import { type EvidenceWriterBundle } from "../publication/service.types";
import { errorOutcome } from "./errorOutcome";
import { type Emit, type PlannedMemory, type WorkerControls } from "./plan.types";
import { requestBytes } from "./requestBytes";

/**
 * The legacy vector's embedding profile is unknown (memories carry no
 * per-row profile), so no vector is reused: chunks are indexed PENDING under
 * the #30 registry's active profile -- the only name `indexRevisionChunks`
 * accepts -- and a backfill (`embedPendingChunks`) re-embeds them.
 */
const REBUILD_PROFILE = { name: activeEmbeddingProfileId(), dims: EMBEDDING_DIMENSION } as const;

/**
 * Materialize what a published revision implies, through the kernel only:
 *
 *   node_revision_terms + revision_links  <- reconcileRevisionAssociations
 *                                            (derived from the revision's own
 *                                            snapshots, so rebuildable)
 *   search_chunks_v1 (status pending)     <- indexRevisionChunks
 *
 * `memory_terms` therefore land as `node_revision_terms` by projection of the
 * authoritative term snapshot, never by a second hand-written copy.
 */
export async function deriveProjections(
  bundle: EvidenceWriterBundle,
  controls: WorkerControls,
  workspace: string,
  memory: PlannedMemory,
  emit: Emit,
): Promise<void> {
  const base = { kind: "projection", workspace, legacy_id: memory.legacy_id };
  const scope = { workspace_name: workspace, node_id: memory.node_id, revision_id: memory.revision_id };
  controls.now = memory.created_at_ms;
  try {
    const reconciled = (await bundle.evidence.reconcileRevisionAssociations(requestBytes(scope))) as Record<string, unknown>;
    const indexed = (await bundle.context.indexRevisionChunks(requestBytes({
      ...scope,
      chunker_version: CHUNKER_VERSION,
      embedding_profile: REBUILD_PROFILE,
    }))) as Record<string, unknown>;
    emit({ ...base, outcome: "ok", reconcile: reconciled.outcome ?? null, chunks: indexed.outcome ?? null });
  } catch (error) {
    emit({ ...base, ...errorOutcome(error) });
  }
}
