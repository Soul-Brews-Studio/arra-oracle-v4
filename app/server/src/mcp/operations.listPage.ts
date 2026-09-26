// One keyset page of an operations-root table (`mcp_calls`, `connections`),
// shared by `calls.listMcpCalls.ts` and `connections.listConnections.ts`
// (#103 / #102, DECISIONS.md R5).
//
// #103 fix round 2 (independent verifier, 2026-09-26): ONE stored row must
// never deny the listing for a whole workspace. Before this file, both
// readers ran every row through the strict target19 codec and turned any
// rejection into `integrity_failure` for the page. The operations root is
// written on the request path by code older than that codec (`logCall`
// stored `session_name` raw; the pre-R5 fold wrote duplicate ids), so rows
// the codec rejects already exist in real stores -- and a `content:read`
// caller could add more at will. The listing then failed for EVERY audit
// reader, and because keyset paging cannot step past a row it cannot
// encode, every later row was hidden too: an audit-evasion path.
//
// Now a row that cannot be answered is WITHHELD from `rows` and REPORTED by
// id in `unreadable`, with a fixed reason:
//
//   unencodable    a stored value fails the wire codec (`integrity_failure`
//                  from `encode`); nothing of the row is echoed but its id
//   duplicate_id   more than one stored row shares this id, so no single
//                  row can honestly be returned for it
//
// Everything else is unchanged: the codec is not loosened, a row is never
// half-returned, `total` still counts what is STORED (so `rows` plus
// `unreadable` across all pages add up to it), and paging advances past a
// withheld id exactly as past a returned one. `unreadable` is present only
// when something was withheld, so a healthy page keeps its exact prior shape.
// Anything other than a codec rejection -- a storage error, a non-string id
// the cursor could not step past -- still fails the request, as before.

import type { Table } from "@lancedb/lancedb";
import { MAX_RESULT_WIRE_BYTES, rowWireBytes } from "../publication/context";
import { failPublication, PublicationError } from "../publication/errors";
import { decodeArrowRows, quote, rawRows } from "../publication/storage";

type Unreadable = { id: string; reason: "unencodable" | "duplicate_id" };

export async function listPage(
  tbl: Table,
  scopes: {
    /** `workspace_name = '<ws>'` only: the exact-identity re-fetch scope. */
    workspace: string;
    /** The SET: workspace plus any filter. `total` counts this. */
    count: string;
    /** `count` narrowed to this PAGE by the cursor. */
    page: string;
  },
  limit: number,
  includeTotal: boolean,
  encode: (row: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ rows: Record<string, unknown>[]; next_after_id: string | null; total: string | null; unreadable?: Unreadable[] }> {
  // KEYSET, never offset: limit+1 detects continuation without paging by
  // position. `id` is each table's primary key and a total order here.
  const arrow = await tbl
    .query()
    .where(scopes.page)
    .select(["id"])
    .orderBy([{ columnName: "id", ascending: true }])
    .limit(limit + 1)
    .toArrow();

  const window: string[] = [];
  for (const row of decodeArrowRows(arrow)) {
    if (typeof row.id !== "string") failPublication("integrity_failure", "");
    window.push(row.id);
  }
  // Continuation is decided on RAW rows, before duplicates collapse: `a, a, b`
  // at limit 2 must still say "more follows", or `b` would never be reached.
  const hasMore = window.length > limit;
  const page: string[] = [];
  for (const id of window.slice(0, limit)) if (!page.includes(id)) page.push(id);

  const rows: Record<string, unknown>[] = [];
  const unreadable: Unreadable[] = [];
  // Cumulative wire budget: over budget fails, it never truncates, which
  // would hand back a short page indistinguishable from a real one. Reports
  // are charged too.
  let budget = 1;
  for (const id of page) {
    // Re-fetched by exact identity (workspace + id only, no filters): the id
    // already came from the filtered scope, so this is an integrity re-check.
    // Limit 2 is what detects a duplicate, including one that straddled the
    // page boundary and so appeared only once in `window`.
    const found = await rawRows(tbl, `${scopes.workspace} AND id = ${quote(id)}`, 2);
    if (found.length === 0) failPublication("integrity_failure", "");
    let encoded: Record<string, unknown> | null = null;
    let withheld: Unreadable | null = null;
    if (found.length > 1) {
      withheld = { id, reason: "duplicate_id" };
    } else {
      try {
        encoded = encode(found[0]!);
      } catch (error) {
        if (!(error instanceof PublicationError) || error.code !== "integrity_failure") throw error;
        withheld = { id, reason: "unencodable" };
      }
    }
    budget += rowWireBytes(encoded ?? withheld!) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    if (encoded !== null) rows.push(encoded);
    else unreadable.push(withheld!);
  }

  const total = includeTotal ? (await tbl.countRows(scopes.count)).toString(10) : null;
  const next_after_id = hasMore && page.length > 0 ? page[page.length - 1]! : null;
  return unreadable.length > 0 ? { rows, next_after_id, total, unreadable } : { rows, next_after_id, total };
}
