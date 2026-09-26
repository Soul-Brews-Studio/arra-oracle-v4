import { MAX_RESULT_WIRE_BYTES, encodeSessionRow, rowWireBytes, type ListSessionsRequest } from "./context";
import { failPublication } from "./errors";
import { quote } from "./storage";
import { SESSIONS, SESSION_PEERS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { type DatasetAdapter } from "./service.types";

/** At most this many memberships are scanned per call when `is_active` also
 *  filters. A page cut short by the bound says so with a non-null cursor. */
const MAX_SCANNED = 1000;

/**
 * K10 `listSessions {member_peer_name}` (docs/overnight/V3-PARITY.md §5; R18):
 * the sessions a peer CURRENTLY belongs to -- a `session_peers` row with
 * `left_at` null -- keyset-paged by session name.
 *
 * The keyset runs over the peer's memberships (`session_name` is unique per
 * (workspace, peer), so ascending name is a total order), and each batch's
 * sessions are fetched in ONE query, never one per row. With no `is_active`
 * filter every membership is one session, so one batch of limit+1 is the page
 * plus its lookahead. With `is_active`, batches continue until the page is
 * full, the memberships run out, or `MAX_SCANNED` is reached; a page cut by
 * that bound may be SHORT with a non-null `next_after_name`, which is still an
 * exact keyset position, never a skipped row.
 *
 * A membership whose session is missing, or two memberships of one session,
 * is corruption: `integrity_failure`, never a silently shorter list.
 */
export async function listMemberSessions(
  reader: DatasetAdapter,
  request: ListSessionsRequest,
): Promise<{ rows: Record<string, unknown>[]; next_after_name: string | null; total: string | null }> {
  const workspace = contextScope(request.workspace_name);
  const memberships = `${workspace} AND peer_name = ${quote(request.member_peer_name!)} AND left_at IS NULL`;
  await reader.refresh(SESSION_PEERS);
  await reader.refresh(SESSIONS);

  const collected: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor = request.after_name;
  let exhausted = false;
  let scanned = 0;
  scan: while (true) {
    const batch = await reader.orderedProjection(
      SESSION_PEERS,
      memberships + (cursor === null ? "" : ` AND session_name > ${quote(cursor)}`),
      ["session_name"],
      { column: "session_name", ascending: true },
      request.limit + 1,
    );
    const names: string[] = [];
    for (const membership of batch) {
      const name = membership.session_name;
      if (typeof name !== "string" || seen.has(name)) failPublication("integrity_failure", "");
      seen.add(name);
      names.push(name);
    }
    const sessions = new Map<string, Record<string, unknown>>();
    if (names.length > 0) {
      const found = await reader.query(SESSIONS, `${workspace} AND name IN (${names.map(quote).join(", ")})`, names.length + 1);
      for (const row of found) {
        const encoded = encodeSessionRow(row);
        if (sessions.has(encoded.name as string)) failPublication("integrity_failure", "");
        sessions.set(encoded.name as string, encoded);
      }
    }
    for (const name of names) {
      const session = sessions.get(name);
      if (session === undefined) failPublication("integrity_failure", "");
      scanned += 1;
      cursor = name;
      if (request.is_active === null || session.is_active === request.is_active) collected.push(session);
      // The page plus ONE lookahead row decides continuation.
      if (collected.length > request.limit) break scan;
    }
    if (batch.length <= request.limit) {
      exhausted = true;
      break;
    }
    if (scanned >= MAX_SCANNED) break;
  }

  const page = collected.slice(0, request.limit);
  const rows: Record<string, unknown>[] = [];
  // Brackets plus one comma per row: sum + n + 1. Over budget fails; it never truncates.
  let budget = 1;
  for (const row of page) {
    budget += rowWireBytes(row) + 1;
    if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
    rows.push(row);
  }
  let next: string | null = null;
  if (collected.length > request.limit) next = page[page.length - 1]!.name as string;
  else if (!exhausted) next = cursor;

  // Opt-in only, and only where one count answers it: the parser refuses a
  // total over both filters.
  let total: string | null = null;
  if (request.include_total) {
    const counted = await reader.count(SESSION_PEERS, memberships);
    if (!Number.isSafeInteger(counted) || counted < 0) failPublication("integrity_failure", "");
    total = counted.toString(10);
  }
  return { rows, next_after_name: next, total };
}
