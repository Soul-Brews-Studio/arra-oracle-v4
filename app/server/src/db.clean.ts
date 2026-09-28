import { wireInteger } from "./db.wireInteger";
import { wireTime } from "./db.wireTime";

// Shapes a raw LanceDB row into the wire response shared by every read
// helper (searchText, searchVector, list, getById).
export const clean = (rows: any[]) =>
  rows.map((r) => ({
    id: r.id,
    name: r.name,
    workspace_name: r.workspace_name,
    session_name: r.session_name ?? null,
    peer_name: r.peer_name ?? null,
    subject_peer_name: r.subject_peer_name ?? null,
    type: r.type,
    content: r.content,
    created_at: wireTime(r.created_at),
    valid_from: wireTime(r.valid_from),
    valid_to: wireTime(r.valid_to),
    sync_state: r.sync_state,
    last_sync_at: wireTime(r.last_sync_at),
    sync_attempts: wireInteger(r.sync_attempts ?? 0),
    superseded_by: r.superseded_by ?? null,
    superseded_at: wireTime(r.superseded_at),
    is_active: Boolean(r.is_active),
    h_metadata: r.h_metadata ?? null,
    embedded: r.embedding != null,
    score: r._score ?? undefined,
    distance: r._distance ?? undefined,
  }));
