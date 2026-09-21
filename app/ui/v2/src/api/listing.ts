/** Typed wrappers over the three enumeration endpoints the EXPLORE page needs
 *  -- `listPeers`, `listSessions`, `listNodes`.
 *
 * These endpoints do NOT exist on the server yet (2026-09-21): three other
 * agents are implementing them in separate worktrees while this file is
 * written against the agreed contract. That makes two things true at once:
 *
 *   - the row shapes below (`PeerRow`, `SessionRow`, `NodeRow`) are a BEST
 *     GUESS at what a listing row mirrors from the underlying store, not a
 *     verified wire shape the way `MessageRow` or `RevisionRow` are
 *     elsewhere in this app. Expect to adjust field names once a real
 *     server responds.
 *   - a server this UI talks to during the gap will answer `method_not_found`
 *     for all three. `toPage` turns that into `supported: false` rather than
 *     an error, so the UI can say "this server does not have listing
 *     endpoints yet" instead of rendering a blank list that looks like zero
 *     rows -- the same "unknown must not read as zero" rule the contract
 *     lays out for `total`.
 *
 * `memory.ts`'s note about no enumeration endpoint (`getPeer`/`getSession`
 * only) is what this file exists to relax -- EXPLORE is the first screen in
 * this app that can show "everything", not just bookmarks you typed in.
 */
import { type ApiResult, callMethod } from "./client";
import { type Bank, asError } from "./memory";

export type PeerRow = { peer_name: string; created_at: string };
export type SessionRow = { session_name: string; created_at: string };
export type NodeRow = {
  node_id: string;
  title: string;
  type_term: string;
  revision_no: string;
  created_at: string;
};

/** One page of a keyset-paginated list.
 *
 *  `total` stays a STRING -- same canonical-decimal rule as `revision_no`
 *  elsewhere: it may exceed 2^53 in principle, so coercing to `Number` here
 *  would be the same silent precision bug the knowledge.ts comments warn
 *  about for `position`. `null` means "not requested, or the server does
 *  not support it", and the two are indistinguishable on purpose -- there is
 *  no way to tell "true zero" from "unknown" from this response alone.
 *
 *  `nextCursor` is opaque and one-directional: it is the value to send back
 *  as `after_name`/`after_id` for the NEXT page, and nothing about it
 *  supports jumping to an arbitrary page. See `explore/Pager.tsx`. */
export type Page<T> = {
  rows: T[];
  nextCursor: string | null;
  total: string | null;
  supported: boolean;
};

const call = (b: Bank, method: string, body: Record<string, unknown>): Promise<ApiResult> =>
  callMethod(b.bank, method, { workspace_name: b.workspace, ...body }, b.token);

/** True when the endpoint ITSELF is absent, as opposed to the request being
 *  bad. Two shapes, and the second was found by measurement rather than by
 *  reading the contract:
 *
 *    - a `method_not_found` envelope, which is what the documented refusal
 *      looks like
 *    - a bare HTTP 404. An unregistered knowledge method is rejected by the
 *      transport BEFORE any kernel runs, so it never reaches the code that
 *      builds an `arra-error/v1` envelope. Measured against a server without
 *      these methods: `POST /api/knowledge/default/listPeers` answers
 *      `404` with the body `{"error":"error"}` -- no code, nothing to match.
 *
 *  Treating only the first shape as unsupported is exactly the false-empty
 *  this function exists to prevent: the UI would render "no peers" over a
 *  server that has no way to tell you whether there are any.
 *
 *  404 is safe to read this way here because every method in this module is
 *  a LISTING call, and a listing has no row-level identity that could be
 *  legitimately not-found. A 404 from these three can only mean the route. */
function isUnsupported(result: ApiResult): boolean {
  if (asError(result.body)?.code === "method_not_found") return true;
  return result.status === 404;
}

function toPage<T>(result: ApiResult, cursorKey: string): Page<T> {
  if (!result.ok) {
    return { rows: [], nextCursor: null, total: null, supported: !isUnsupported(result) };
  }
  const body = result.body as Record<string, unknown>;
  const rows = Array.isArray(body.rows) ? (body.rows as T[]) : [];
  const nextCursor = typeof body[cursorKey] === "string" ? (body[cursorKey] as string) : null;
  const total = typeof body.total === "string" ? body.total : null;
  return { rows, nextCursor, total, supported: true };
}

export async function listPeers(
  b: Bank,
  afterName: string | null,
  limit: number,
  includeTotal: boolean,
): Promise<Page<PeerRow>> {
  const result = await call(b, "listPeers", {
    after_name: afterName,
    limit,
    ...(includeTotal ? { include_total: true } : {}),
  });
  return toPage<PeerRow>(result, "next_after_name");
}

export async function listSessions(
  b: Bank,
  afterName: string | null,
  limit: number,
  includeTotal: boolean,
): Promise<Page<SessionRow>> {
  const result = await call(b, "listSessions", {
    after_name: afterName,
    limit,
    ...(includeTotal ? { include_total: true } : {}),
  });
  return toPage<SessionRow>(result, "next_after_name");
}

export async function listNodes(
  b: Bank,
  afterId: string | null,
  limit: number,
  includeTotal: boolean,
  typeTerm: string | null,
): Promise<Page<NodeRow>> {
  const result = await call(b, "listNodes", {
    after_id: afterId,
    limit,
    ...(includeTotal ? { include_total: true } : {}),
    ...(typeTerm !== null ? { type_term: typeTerm } : {}),
  });
  return toPage<NodeRow>(result, "next_after_id");
}
