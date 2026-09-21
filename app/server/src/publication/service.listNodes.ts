import { failPublication } from "./errors";
import { encodeNodeRow, encodeRevisionRow, MAX_CHAIN_WIRE_BYTES } from "./rows";
import { quote } from "./storage";
import { contextOne } from "./service.contextOne";
import { NODE_REVISIONS, NODES, scopeOf } from "./service.constants";
import { deriveNodeType } from "./service.deriveNodeType";
import { parseListNodes } from "./service.parseListNodes";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";
import { wireBytesOf } from "./service.wireBytesOf";

/**
 * Bounded scan window for a `type_term`-filtered page. Matches may be sparse
 * across the id-ordered keyset, so `limit` (a count of MATCHES) cannot also
 * bound how many nodes get examined to find them -- this is the separate cap
 * on that examination work, one call's worth, mirroring `scanDependents`'
 * `MAX_VISITED_NODES` for the same reason: a rare filter value must never
 * turn a single request into an unbounded scan. Set well above
 * `MAX_PAGE_LIMIT` because examining one node here is cheap (two point
 * reads and a JSON parse), unlike `scanDependents`' full ancestry+link walk.
 */
const MAX_SCANNED_NODES = 1000;

/**
 * Workspace-scoped, keyset-paginated node listing (#88).
 *
 * `getAcceptedHead`/`listAcceptedHistory` are get-by-id only -- neither
 * returns a bare `node_id` a caller could capture, so both are unreachable
 * without something that enumerates. This is that something.
 */
export async function listNodes(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null }> {
  const request = parseListNodes(requestBytes);
  await requireWorkspace(reader, request.workspace_name);

  await reader.refresh(NODES);
  const scope = scopeOf(request.workspace_name);
  const idScope = scope + (request.after_id === null ? "" : ` AND id > ${quote(request.after_id)}`);

  // KEYSET, never offset: paging by position would skip or repeat rows as
  // the table grows. `nodes.id` is a nanoid21 primary key and therefore a
  // total order, which is exactly what makes ascending `id` a safe keyset
  // boundary here -- the same shape listMessages uses over seq_in_session.
  //
  // Unfiltered, the scan window IS the page: limit+1 is the classic
  // lookahead that detects continuation without a second round trip. A
  // `type_term` filter breaks that equivalence -- matches can be sparse
  // across the id order -- so it widens the window to MAX_SCANNED_NODES
  // instead and the loop below stops on MATCH count, not window position.
  const scanLimit = request.type_term === null ? request.limit + 1 : MAX_SCANNED_NODES;

  const selected = await reader.orderedProjection(
    NODES,
    idScope,
    ["id"],
    { column: "id", ascending: true },
    scanLimit,
  );

  const ids: string[] = [];
  for (const row of selected) {
    const id = row.id;
    if (typeof id !== "string") failPublication("integrity_failure", "");
    // A duplicate id at a page edge would be invisible to keyset advancement;
    // catch it here rather than let it silently skip or repeat a page.
    if (ids.includes(id)) failPublication("integrity_failure", "");
    ids.push(id);
  }

  await reader.refresh(NODE_REVISIONS);

  const rows: Record<string, unknown>[] = [];
  // Brackets plus one comma per row: sum + n + 1.
  let budget = 1;
  let lastExaminedId: string | null = null;
  let consumed = 0;

  for (const id of ids) {
    consumed += 1;
    lastExaminedId = id;

    const node = await contextOne(reader, NODES, `${scope} AND id = ${quote(id)}`);
    if (node === null) failPublication("integrity_failure", "");
    const encodedNode = encodeNodeRow(node);

    // Read the head through the SAME `current_revision_id` pointer
    // `getAcceptedHead` uses -- never re-derive "latest" by sorting
    // revisions, which would be a second, divergent definition of head.
    const headId = encodedNode.current_revision_id;
    // Every node this kernel creates is written WITH its first revision's id
    // already in `current_revision_id` (`service.publishRevision`'s
    // `createFirstRevision`), and every write path that later finds it null
    // treats that as `integrity_failure`, never a legitimate transitional
    // state (see `readHeadAndAncestry`, `publishRevision`'s orphan checks). A
    // listing follows that SAME rule rather than inventing a softer one: a
    // null head is corruption to report, not an emptier row to render and
    // not a row to silently drop.
    if (typeof headId !== "string") failPublication("integrity_failure", "");

    const revision = await contextOne(reader, NODE_REVISIONS, `${scope} AND id = ${quote(headId)}`);
    // A `current_revision_id` pointing at no row is the same corruption as a
    // null one -- a dangling pointer, not a softer "row missing" outcome.
    if (revision === null) failPublication("integrity_failure", "");
    const encodedRevision = encodeRevisionRow(revision);

    if (request.type_term !== null) {
      // Filters on `node_revisions.term_snapshot_json` (via the SAME decoder
      // `deriveNodeType` already uses for the same field elsewhere), NOT on
      // the derived `node_revision_terms` projection. That projection only
      // exists once `reconcileRevisionAssociations` has run for a revision;
      // a freshly published node has zero rows there until then. Filtering
      // on it would silently miss every unreconciled node and present that
      // partial set as if it were complete -- the snapshot, by contrast, is
      // written WITH the revision and is never behind a separate write.
      const nodeType = deriveNodeType(encodedRevision);
      if (nodeType !== request.type_term) continue;
    }

    const encoded = {
      ...encodedNode,
      title: encodedRevision.title,
      revision_no: encodedRevision.revision_no,
      content_digest: encodedRevision.content_digest,
    };
    budget += wireBytesOf(encoded) + 1;
    // Cumulative wire budget. Over budget fails; it never truncates, which
    // would hand back a short page indistinguishable from a real one.
    if (budget > MAX_CHAIN_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(encoded);
    if (rows.length >= request.limit) break;
  }

  // More already-fetched ids were never examined (stopped on a filled match
  // limit), OR the fetched window was itself capped at `scanLimit` and might
  // continue beyond it -- either way there could be more. Only when the
  // window was consumed in full AND fell short of `scanLimit` is the
  // workspace (optionally filtered) truly exhausted.
  const hasMore = consumed < ids.length || ids.length === scanLimit;
  const next_after_id = hasMore && lastExaminedId !== null ? lastExaminedId : null;

  let total: string | null = null;
  if (request.include_total) {
    if (request.type_term === null) {
      // Native, predicate-scoped count -- never materializes a row into JS.
      const n = await reader.count(NODES, scope);
      total = n.toString(10);
    }
    // A `type_term` total has no equivalent native shape: the type lives in
    // JSON text on each revision, not a physical/indexed column, so the only
    // way to count it exactly is reading and parsing every candidate
    // revision -- precisely the unbounded full-materialize-to-count this
    // kernel refuses to do to fake a total. `total` stays null here: an
    // honest "not computed", never an approximation presented as exact.
  }

  return { rows, next_after_id, total };
}
