import { failPublication } from "./errors";
import { quote } from "./storage";
import { parseSnapshotArray } from "./service.parseSnapshotArray";
import { requireExactlyOne } from "./service.requireExactlyOne";
import { type DatasetAdapter } from "./service.types";
import { walkAncestry } from "./service.walkAncestry";

/** Internal link kinds resolve within W; external locators stay passive. */
export async function validateLinkReferences(
  adapter: DatasetAdapter,
  workspace: string,
  nodeId: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  const entries = parseSnapshotArray(encoded.link_snapshot_json, "/content/link_snapshot_json");
  const path = "/content/link_snapshot_json";

  for (const entry of entries) {
    const kind = entry.target_kind;
    const target = entry.target as Record<string, unknown> | null;
    if (kind === "node_revision") {
      const targetNodeId = target?.node_id as string | undefined;
      const targetRevisionId = target?.revision_id as string | undefined;
      if (typeof targetNodeId !== "string" || typeof targetRevisionId !== "string") {
        failPublication("invalid_reference", path);
      }
      const targetNode = await requireExactlyOne(
        adapter,
        "nodes",
        `workspace_name = ${quote(workspace)} AND id = ${quote(targetNodeId)}`,
        path,
      );
      const head = targetNode.current_revision_id;
      if (typeof head !== "string") failPublication("invalid_reference", path);
      // The target revision must be in the target node's ACCEPTED ancestry;
      // a row merely existing in the table is not a valid reference.
      const ancestry = await walkAncestry(adapter, workspace, targetNodeId, head);
      if (!ancestry.encoded.some((row) => row.id === targetRevisionId)) {
        failPublication("invalid_reference", path);
      }
      // NO blanket same-node ban. The contract requires the target revision
      // to be in the target node's ACCEPTED ancestry, and that already
      // excludes the revision now being created -- it is not accepted yet.
      // A reference to an earlier ACCEPTED revision of the same node is
      // legitimate, so rejecting it outright was an invented restriction.
      continue;
    }
    if (kind === "message") {
      // Canonical key names come from the protected codec's TARGET_KEYS:
      // message is (session_name, message_public_id). Reading `public_id`
      // here was an invented spelling that silently matched nothing.
      const sessionName = target?.session_name as string | undefined;
      const publicId = target?.message_public_id as string | undefined;
      if (typeof sessionName !== "string" || typeof publicId !== "string") {
        failPublication("invalid_reference", path);
      }
      await requireExactlyOne(
        adapter,
        "sessions",
        `workspace_name = ${quote(workspace)} AND name = ${quote(sessionName)}`,
        path,
      );
      await requireExactlyOne(
        adapter,
        "messages",
        `workspace_name = ${quote(workspace)} AND session_name = ${quote(sessionName)} AND public_id = ${quote(publicId)}`,
        path,
      );
      continue;
    }
    if (kind === "session") {
      // TARGET_KEYS.session is ["session_name"], not "name".
      const name = target?.session_name as string | undefined;
      if (typeof name !== "string") failPublication("invalid_reference", path);
      await requireExactlyOne(
        adapter,
        "sessions",
        `workspace_name = ${quote(workspace)} AND name = ${quote(name)}`,
        path,
      );
      continue;
    }
    if (kind === "trace") {
      // TARGET_KEYS.trace is ["trace_id"], not "id".
      const id = target?.trace_id as string | undefined;
      if (typeof id !== "string") failPublication("invalid_reference", path);
      await requireExactlyOne(
        adapter,
        "traces",
        `workspace_name = ${quote(workspace)} AND id = ${quote(id)}`,
        path,
      );
      continue;
    }
    // Every other kind is a validated PASSIVE external locator. Nothing is
    // fetched, no model is called and no capture truth is asserted: the byte
    // and shape contract was already checked by the governed codec.
  }
}
