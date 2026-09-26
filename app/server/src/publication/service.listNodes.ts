import { failPublication } from "./errors";
import { encodeNodeRow, encodeRevisionRow, MAX_CHAIN_WIRE_BYTES, microsToTimestamp, timestampToMicros } from "./rows";
import { quote } from "./storage";
import { contextOne } from "./service.contextOne";
import { NODE_REVISIONS, NODES, SUPERSEDE_LOG, scopeOf } from "./service.constants";
import { deriveNodeType } from "./service.deriveNodeType";
import { terminalEventsFor } from "./service.terminalEventsFor";
import { parseListNodes } from "./service.parseListNodes";
import { requireWorkspace } from "./service.requireWorkspace";
import { snapshotTermIds } from "./service.snapshotTermIds";
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
): Promise<{
  rows: Record<string, unknown>[];
  next_after_id: string | null;
  /** K4: the `updated_desc` half of the keyset pair. `null` in `id_asc` mode
   *  (`order`'s default) and whenever the page is the last one. */
  next_after_updated_at: string | null;
  total: string | null;
}> {
  const request = parseListNodes(requestBytes);
  await requireWorkspace(reader, request.workspace_name);

  await reader.refresh(NODES);
  const scope = scopeOf(request.workspace_name);

  // Unfiltered, the scan window IS the page: limit+1 is the classic
  // lookahead that detects continuation without a second round trip. A
  // `type_term`/`all_term_ids`/`any_term_ids` filter breaks that
  // equivalence -- matches can be sparse across the scan order -- so it
  // widens the window to MAX_SCANNED_NODES instead and the loop below stops
  // on MATCH count, not window position.
  //
  // #29 slice B (overnight R7): `include_inactive: false` (the ordinary
  // default) is exactly the same kind of filter -- a retired or superseded
  // node drops out of the window just like a wrong `type_term` does -- so it
  // widens the scan window the SAME way.
  //
  // K4 (overnight R18): `order: "updated_desc"` ALSO always widens the
  // window, filtered or not: a single-column SQL `ORDER BY updated_at` makes
  // no promise about how it breaks a tie on that column, and this kernel
  // needs a deterministic (updated_at desc, id asc) tie order to make the
  // `after_id`/`after_updated_at` keyset pair well-defined across a page
  // boundary -- see the sort below. Only the fully unfiltered `id_asc` case
  // (no term filter, history mode) keeps the tight limit+1 window.
  const filtered = request.type_term !== null || request.all_term_ids !== null || request.any_term_ids !== null || !request.include_inactive;
  const scanLimit = filtered || request.order === "updated_desc" ? MAX_SCANNED_NODES : request.limit + 1;

  const ids: string[] = [];
  // K4: populated only in `updated_desc` mode, keyed by id, so `hasMore`'s
  // `lastExaminedId` can be turned back into the wire cursor text below
  // without a second read of the same row.
  const updatedAtMicrosById = new Map<string, bigint>();

  if (request.order === "updated_desc") {
    let boundary = scope;
    // Parse-time already guarantees `after_updated_at` is non-null exactly
    // when `after_id` is (`service.parseListNodes.ts`'s pair check) -- so
    // `after_id !== null` alone decides whether this is a continuation.
    if (request.after_id !== null) {
      const afterMicros = timestampToMicros(request.after_updated_at).toString(10);
      const cast = `CAST(${afterMicros} AS TIMESTAMP(6))`;
      // Strictly AFTER the last row already returned, in (updated_at desc,
      // id asc) order: an earlier timestamp, or the SAME timestamp with a
      // larger id (the tie-break direction the sort below also uses).
      boundary += ` AND (updated_at < ${cast} OR (updated_at = ${cast} AND id > ${quote(request.after_id)}))`;
    }
    const selected = await reader.orderedProjection(
      NODES,
      boundary,
      ["id", "updated_at"],
      { column: "updated_at", ascending: false },
      scanLimit,
    );
    const decoded: { id: string; updatedAt: bigint }[] = [];
    for (const row of selected) {
      const id = row.id;
      const updatedAt = row.updated_at;
      if (typeof id !== "string") failPublication("integrity_failure", "");
      if (typeof updatedAt !== "bigint") failPublication("integrity_failure", "");
      if (updatedAtMicrosById.has(id)) failPublication("integrity_failure", "");
      updatedAtMicrosById.set(id, updatedAt);
      decoded.push({ id, updatedAt });
    }
    // A single-column `ORDER BY` cannot promise a stable tie order for equal
    // `updated_at` values, so this window's delivery order is re-sorted here,
    // deterministically, to (updated_at desc, id asc) -- the SAME pair the
    // boundary predicate above excludes by. Within one `MAX_SCANNED_NODES`
    // window this is exact; a tie wider than that window (an improbable
    // number of nodes sharing one microsecond) is the same documented,
    // bounded-scan trade-off `MAX_SCANNED_NODES` already states for a rare
    // `type_term` value.
    decoded.sort((a, b) => {
      if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (const d of decoded) ids.push(d.id);
  } else {
    const idScope = scope + (request.after_id === null ? "" : ` AND id > ${quote(request.after_id)}`);
    // KEYSET, never offset: paging by position would skip or repeat rows as
    // the table grows. `nodes.id` is a nanoid21 primary key and therefore a
    // total order, which is exactly what makes ascending `id` a safe keyset
    // boundary here -- the same shape listMessages uses over seq_in_session.
    const selected = await reader.orderedProjection(
      NODES,
      idScope,
      ["id"],
      { column: "id", ascending: true },
      scanLimit,
    );
    for (const row of selected) {
      const id = row.id;
      if (typeof id !== "string") failPublication("integrity_failure", "");
      // A duplicate id at a page edge would be invisible to keyset advancement;
      // catch it here rather than let it silently skip or repeat a page.
      if (ids.includes(id)) failPublication("integrity_failure", "");
      ids.push(id);
    }
  }

  await reader.refresh(NODE_REVISIONS);

  // #29 slice B: ONE `supersede_log` query for the whole scanned window
  // (`old_id IN (...)`), never one per node -- analysis-29.json fix plan B1.
  const terminal = await terminalEventsFor(reader, request.workspace_name, ids);

  const rows: Record<string, unknown>[] = [];
  // Brackets plus one comma per row: sum + n + 1.
  let budget = 1;
  let lastExaminedId: string | null = null;
  let consumed = 0;

  for (const id of ids) {
    consumed += 1;
    lastExaminedId = id;

    const lifecycle = terminal.get(id) ?? null;
    // The "current" default excludes a node with its own terminal event
    // BEFORE the node/revision point-reads below -- cheaper (the lookup
    // already ran, batched, above) and it keeps a retired/superseded node
    // out of the `type_term` derivation entirely, matching the same
    // "examined but not matched" bookkeeping `type_term` filtering uses.
    if (!request.include_inactive && lifecycle !== null) continue;

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

    // K3 (overnight R18): same snapshot source as `type_term` above, just
    // read generically instead of specialized to the reserved `type` entry.
    // Only parsed when at least one of the two filters is active, so an
    // unfiltered request pays no extra parse.
    if (request.all_term_ids !== null || request.any_term_ids !== null) {
      const termIds = snapshotTermIds(encodedRevision);
      if (request.all_term_ids !== null && !request.all_term_ids.every((wanted) => termIds.includes(wanted))) continue;
      if (request.any_term_ids !== null && !request.any_term_ids.some((wanted) => termIds.includes(wanted))) continue;
    }

    const encoded = {
      ...encodedNode,
      title: encodedRevision.title,
      revision_no: encodedRevision.revision_no,
      content_digest: encodedRevision.content_digest,
      // #29 slice B: every row carries this, in both modes -- "active" is
      // not an absence of information, it is the answer, the same way
      // `eligible: true` is a real answer on `getRecallEligibility`.
      lifecycle_state: lifecycle === null ? "active" : lifecycle.kind,
      new_id: lifecycle?.new_id ?? null,
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
  // K4: the paired cursor half, only meaningful (and only ever non-null) in
  // `updated_desc` mode -- `updatedAtMicrosById` is empty in `id_asc` mode, so
  // this stays null there with no extra branch needed.
  const next_after_updated_at =
    next_after_id !== null && updatedAtMicrosById.has(next_after_id)
      ? microsToTimestamp(updatedAtMicrosById.get(next_after_id)!)
      : null;

  let total: string | null = null;
  if (request.include_total) {
    if (request.type_term === null && request.all_term_ids === null && request.any_term_ids === null) {
      // Native, predicate-scoped count -- never materializes a row into JS.
      const n = await reader.count(NODES, scope);
      if (request.include_inactive) {
        total = n.toString(10);
      } else {
        // #29 slice B (overnight R7, amending the PRs #99/#100 frozen
        // `total` semantics -- see lifecycle-v1.md's amendment): the
        // "current" default's `total` counts the FILTERED set, i.e. every
        // node minus every node with its own terminal `supersede_log` row.
        // This is an EXACT identity, not an approximation or a scan-and-
        // count: `old_id` is scoped-unique (`writeLifecycleEventFresh`'s
        // `already_terminal` rule) and every event names a node that exists
        // in THIS workspace (`invalid_reference` refuses any other), so
        // `count(supersede_log, scope)` is precisely the number of terminal
        // nodes in scope -- two native counts, no join, no row read.
        //
        // Deliberately NOT extended to `is_active`/the validity window:
        // those live inside `node_revisions`, so a native subtraction like
        // this one does not exist for them, and this kernel already refuses
        // to fake an exact total with a full scan (the same rule `type_term`
        // above states). Those two predicates stay additive-only, surfaced
        // through `getRecallEligibility`'s `reasons`, `getAcceptedHead` and
        // `listAcceptedHistory`'s `lifecycle` label -- never silently folded
        // into this count.
        const terminalCount = await reader.count(SUPERSEDE_LOG, scope);
        total = (n - terminalCount).toString(10);
      }
    }
    // A `type_term`/`all_term_ids`/`any_term_ids` total has no equivalent
    // native shape: term assignment lives in JSON text on each revision, not
    // a physical/indexed column, so the only way to count it exactly is
    // reading and parsing every candidate revision -- precisely the unbounded
    // full-materialize-to-count this kernel refuses to do to fake a total.
    // `total` stays null here: an honest "not computed", never an
    // approximation presented as exact.
  }

  return { rows, next_after_id, next_after_updated_at, total };
}
