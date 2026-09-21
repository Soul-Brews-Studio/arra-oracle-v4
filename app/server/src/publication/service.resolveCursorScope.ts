import { encodePeerRow, encodeSessionRow } from "./context";
import { failPublication } from "./errors";
import { validateWorkspaceRow } from "./read-cursor";
import { quote } from "./storage";
import { PEERS, SESSIONS, WORKSPACES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/**
 * Resolve the three request references, IN ORDER, each at its own pointer.
 *
 * An inactive session and a departed membership do NOT forbid reading or
 * recording progress: retained history stays addressable. No membership row is
 * required for the observing peer and none is created, which is a deliberate
 * difference from appendMessages, whose active-membership rule is untouched.
 */
export async function resolveCursorScope(
  adapter: DatasetAdapter,
  request: { workspace_name: string; peer_name: string; session_name: string },
): Promise<void> {
  await adapter.refresh(WORKSPACES);
  const workspace = await contextOne(
    adapter,
    WORKSPACES,
    `name = ${quote(request.workspace_name)}`,
  );
  if (workspace === null) failPublication("invalid_reference", "/workspace_name");
  // A malformed retained workspace is corruption at ROOT, decided BEFORE the
  // peer lookup so a broken workspace is never reported as a missing peer.
  const validated = validateWorkspaceRow(workspace);
  if (validated.name !== request.workspace_name) failPublication("integrity_failure", "");

  // Each reference is resolved AND validated before the next is looked up.
  // Deferring validation would let a malformed peer be reported as a missing
  // session, which names the wrong reference to whoever has to fix it.
  await adapter.refresh(PEERS);
  const peer = await contextOne(
    adapter,
    PEERS,
    `${contextScope(request.workspace_name)} AND name = ${quote(request.peer_name)}`,
  );
  if (peer === null) failPublication("invalid_reference", "/peer_name");
  // Full ACCEPTED encoder: a structurally broken peer is stored corruption
  // even when this operation would not have read its fields.
  encodePeerRow(peer);

  await adapter.refresh(SESSIONS);
  const session = await contextOne(
    adapter,
    SESSIONS,
    `${contextScope(request.workspace_name)} AND name = ${quote(request.session_name)}`,
  );
  if (session === null) failPublication("invalid_reference", "/session_name");
  encodeSessionRow(session);
}
