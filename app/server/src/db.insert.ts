import { db } from "./db.db";
import { requiredBank } from "./db.requiredBank";

export type NewMemory = {
  name: string;
  content: string;
  workspace_name?: string;
  type?: string;
  session_name?: string | null;
  peer_name?: string | null;
  subject_peer_name?: string | null;
};

// Insert canonical text only. Model I/O belongs to explicit backfill until the
// durable async reconciliation worker in #30 exists; remember must ACK even if
// the configured embedder hangs forever.
export async function insert(m: NewMemory): Promise<{ id: string; embedded: boolean }> {
  // Fail closed: a write with no scope is an error, never an invented bank.
  // Inventing `default` silently placed unscoped rows into a real workspace.
  const scopedBank = requiredBank(m.workspace_name);
  const tbl = await db();
  const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    name: m.name,
    workspace_name: scopedBank,
    session_name: m.session_name ?? null,
    peer_name: m.peer_name ?? null,
    subject_peer_name: m.subject_peer_name ?? null,
    type: m.type ?? "note",
    content: m.content,
    embedding: null as number[] | null,
    created_at: new Date(),
    valid_from: null,
    valid_to: null,
    sync_state: "pending",
    last_sync_at: null as Date | null,
    sync_attempts: 0,
    superseded_by: null,
    superseded_at: null,
    is_active: true,
    h_metadata: null,
    internal_metadata: null,
  };

  // Canonical text is durable before any model/network call. Derived search
  // state may lag and is explicitly visible through sync_state.
  await tbl.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([row]);
  return { id, embedded: false };
}
