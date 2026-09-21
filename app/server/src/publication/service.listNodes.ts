import { failPublication } from "./errors";
import { encodeNodeRow, encodeRevisionRow, MAX_CHAIN_WIRE_BYTES } from "./rows";
import { quote } from "./storage";
import { contextOne } from "./service.contextOne";
import { NODE_REVISIONS, NODES, scopeOf } from "./service.constants";
import { parseListNodes } from "./service.parseListNodes";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";
import { wireBytesOf } from "./service.wireBytesOf";

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
): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null }> {
  const request = parseListNodes(requestBytes);
  await requireWorkspace(reader, request.workspace_name);

  await reader.refresh(NODES);
  const scope =
    scopeOf(request.workspace_name) +
    (request.after_id === null ? "" : ` AND id > ${quote(request.after_id)}`);

  // KEYSET, never offset: limit+1 detects continuation without paging by
  // position, which would skip or repeat rows as the table grows -- the same
  // shape listMessages uses over seq_in_session. `nodes.id` is a nanoid21
  // primary key and therefore a total order, which is exactly what makes
  // ascending `id` a safe keyset boundary here.
  const selected = await reader.orderedProjection(
    NODES,
    scope,
    ["id"],
    { column: "id", ascending: true },
    request.limit + 1,
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

  const page = ids.slice(0, request.limit);
  await reader.refresh(NODE_REVISIONS);

  const rows: Record<string, unknown>[] = [];
  // Brackets plus one comma per row: sum + n + 1.
  let budget = 1;
  for (const id of page) {
    const node = await contextOne(reader, NODES, `${scopeOf(request.workspace_name)} AND id = ${quote(id)}`);
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

    const revision = await contextOne(
      reader,
      NODE_REVISIONS,
      `${scopeOf(request.workspace_name)} AND id = ${quote(headId)}`,
    );
    // A `current_revision_id` pointing at no row is the same corruption as a
    // null one -- a dangling pointer, not a softer "row missing" outcome.
    if (revision === null) failPublication("integrity_failure", "");
    const encodedRevision = encodeRevisionRow(revision);

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
  }

  const hasMore = ids.length > request.limit;
  return {
    rows,
    next_after_id: hasMore && page.length > 0 ? page[page.length - 1]! : null,
  };
}
