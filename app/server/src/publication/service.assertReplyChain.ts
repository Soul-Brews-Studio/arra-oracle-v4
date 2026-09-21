import { encodeMessageRow } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { MESSAGES } from "./service.constants";
import { contextOne } from "./service.contextOne";
import { type DatasetAdapter } from "./service.types";

/**
 * Walk an existing reply chain, bounded.
 *
 * Counts STORED ancestors traversed; the row being appended is not yet in the
 * chain and is not counted. 1024 visited is allowed, 1025 fails.
 */
export async function assertReplyChain(
  adapter: DatasetAdapter,
  workspace: string,
  session: string,
  parent: Record<string, unknown>,
): Promise<void> {
  let cursor: Record<string, unknown> | null = parent;
  let visited = 0;
  const seen = new Set<string>();
  while (cursor !== null) {
    visited += 1;
    if (visited > 1024) failPublication("limit_exceeded", "");
    const encoded = encodeMessageRow(cursor);
    const id = encoded.public_id as string;
    if (seen.has(id)) failPublication("integrity_failure", "");
    seen.add(id);
    if (encoded.session_name !== session || encoded.workspace_name !== workspace) {
      failPublication("integrity_failure", "");
    }
    const next = encoded.in_reply_to as string | null;
    if (next === null) return;
    cursor = await contextOne(
      adapter,
      MESSAGES,
      `workspace_name = ${quote(workspace)} AND session_name = ${quote(session)} AND public_id = ${quote(next)}`,
    );
    if (cursor === null) failPublication("integrity_failure", "");
  }
}
