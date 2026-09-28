import { wireTime } from "./db.wireTime";
import { wireInteger } from "./db.wireInteger";

// Reverse of `migration/buildRevisionRequest.ts`: maps one target-19
// `getAcceptedHead` answer (node + head revision + lifecycle label) back to
// the EXACT wire shape `db.clean.ts` produces for every legacy read helper
// (`getById`/`list`/`searchText`/`searchVector`) -- studied from
// `migration/buildRevisionRequest.ts` (the forward mapping) and `db.clean.ts`
// itself (the wire shape, not the raw insert row: no `embedding` array,
// `embedded`/`score`/`distance` instead, timestamps pre-formatted).
export type LegacyMemoryRow = {
  id: string;
  name: string;
  workspace_name: string;
  session_name: string | null;
  peer_name: string | null;
  subject_peer_name: string | null;
  type: string;
  content: string;
  created_at: string | number | null;
  valid_from: string | number | null;
  valid_to: string | number | null;
  sync_state: string;
  last_sync_at: string | number | null;
  sync_attempts: number | string;
  superseded_by: string | null;
  superseded_at: string | number | null;
  is_active: boolean;
  h_metadata: string | null;
  embedded: boolean;
  score: undefined;
  distance: undefined;
};

type TermSnapshot = { vocabulary_name_snapshot?: unknown; term_name_snapshot?: unknown };

function parseTerms(termSnapshotJson: string): TermSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(termSnapshotJson);
    return Array.isArray(parsed) ? (parsed as TermSnapshot[]) : [];
  } catch {
    return [];
  }
}

// R11: a reserved `type` term always comes first; a non-reserved legacy
// string travels alongside as a `legacy_type` term (`buildRevisionRequest.ts`).
// The legacy string, when present, is the one to surface as `type` -- it is
// the exact value the legacy writer stored; the reserved term is its R11
// projection, not the original.
function deriveType(termSnapshotJson: string): string {
  const terms = parseTerms(termSnapshotJson);
  const legacy = terms.find((t) => t.vocabulary_name_snapshot === "legacy_type");
  if (legacy && typeof legacy.term_name_snapshot === "string") return legacy.term_name_snapshot;
  const reserved = terms.find((t) => t.vocabulary_name_snapshot === "type");
  if (reserved && typeof reserved.term_name_snapshot === "string") return reserved.term_name_snapshot;
  return "note";
}

// `buildRevisionRequest.ts` never carries the legacy `peer_name` forward
// (author/observer stay null, "attribution_unresolved"); it survives only if
// a caller's `internal_metadata` happens to record it under this key.
function derivePeerName(internalMetadataJson: string | null): string | null {
  if (internalMetadataJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(internalMetadataJson);
    if (parsed && typeof parsed === "object" && "legacy_peer_name" in parsed) {
      const value = (parsed as Record<string, unknown>).legacy_peer_name;
      return typeof value === "string" ? value : null;
    }
  } catch {
    // fallthrough
  }
  return null;
}

export function mapAcceptedHeadToMemory(found: {
  node: Record<string, unknown>;
  revision: Record<string, unknown>;
  lifecycle: { kind: string; new_id: string | null } | null;
}): LegacyMemoryRow {
  const { node, revision, lifecycle } = found;
  const internalMetadata = (revision.internal_metadata as string | null) ?? null;
  return {
    id: node.id as string,
    name: revision.title as string,
    workspace_name: node.workspace_name as string,
    session_name: (revision.session_name as string | null) ?? null,
    peer_name: derivePeerName(internalMetadata),
    subject_peer_name: (revision.subject_peer_name as string | null) ?? null,
    type: deriveType(revision.term_snapshot_json as string),
    content: revision.body as string,
    created_at: wireTime(revision.created_at),
    valid_from: wireTime(revision.valid_from),
    valid_to: wireTime(revision.valid_to),
    // Lifecycle (retired/superseded, #29) is the only source of a
    // legacy-shaped sync/supersede state target-19 still carries; anything
    // already accepted and not terminal reads as "synced", never "pending"
    // (this path never writes, so nothing here is ever mid-sync).
    sync_state: lifecycle === null ? "synced" : lifecycle.kind === "superseded" ? "superseded" : "retired",
    last_sync_at: null,
    sync_attempts: wireInteger(0),
    superseded_by: lifecycle?.new_id ?? null,
    superseded_at: null,
    is_active: Boolean(revision.is_active) && lifecycle === null,
    h_metadata: (revision.h_metadata as string | null) ?? null,
    // Vector state lives in `search_chunks_v1`, not the node/revision this
    // path reads; `db.legacyRead.searchVector.ts`'s own semantic hits are the
    // only case where a stored embedding was actually involved.
    embedded: false,
    score: undefined,
    distance: undefined,
  };
}
