import { failPublication } from "./errors";
import { EMPTY_ARRAY_BYTES, MAX_CHAIN_ROWS, MAX_CHAIN_WIRE_BYTES, parseInt64Text, revisionWireBytes } from "./rows";
import { decodeVerifiedRevision } from "./service.decodeVerifiedRevision";
import { findRevisionById } from "./service.findRevisionById";
import { type Ancestry, type DatasetAdapter, type RevisionRow } from "./service.types";

/**
 * Walk the accepted chain backwards from `headId`, oldest-first on return.
 *
 * Budgets are checked DURING traversal, not after assembling everything: the
 * point of a 16 MiB bound is to avoid building a history that large in the
 * first place. One fetched row may cross the budget; this is a wire bound,
 * not a process-memory sandbox.
 */
export async function walkAncestry(
  reader: DatasetAdapter,
  workspace: string,
  nodeId: string,
  headId: string,
): Promise<Ancestry> {
  const rows: RevisionRow[] = [];
  const encoded: Record<string, unknown>[] = [];
  let wireBytes = EMPTY_ARRAY_BYTES;
  const seen = new Set<string>();

  let cursor: string | null = headId;
  while (cursor !== null) {
    if (seen.has(cursor)) failPublication("integrity_failure"); // cycle
    seen.add(cursor);
    if (rows.length >= MAX_CHAIN_ROWS) failPublication("limit_exceeded");

    const row = await findRevisionById(reader, workspace, cursor);
    if (row === null) failPublication("integrity_failure"); // missing ancestor
    if (row.node_id !== nodeId) failPublication("integrity_failure"); // cross-node
    if (row.workspace_name !== workspace) failPublication("integrity_failure");

    const encodedRow = decodeVerifiedRevision(row);
    const ordinal = parseInt64Text(encodedRow.revision_no);
    if (ordinal <= 0n) failPublication("integrity_failure");

    // Cumulative accounting, checked before accepting the row.
    wireBytes += revisionWireBytes(encodedRow) + (rows.length > 0 ? 1 : 0);
    if (wireBytes > MAX_CHAIN_WIRE_BYTES) failPublication("limit_exceeded");

    rows.push(row);
    encoded.push(encodedRow);

    const base = encodedRow.base_revision_id;
    cursor = base === null ? null : (base as string);
  }

  rows.reverse();
  encoded.reverse();

  // Ordinals must be exactly 1..n with the first having a null base.
  for (let i = 0; i < encoded.length; i++) {
    const ordinal = parseInt64Text(encoded[i]!.revision_no);
    if (ordinal !== BigInt(i + 1)) failPublication("integrity_failure");
    if (i === 0 && encoded[i]!.base_revision_id !== null) failPublication("integrity_failure");
  }
  return { rows, encoded, wireBytes };
}
