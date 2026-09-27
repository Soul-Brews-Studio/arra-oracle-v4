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

/* Row shapes, VERIFIED against the running server rather than assumed.
 *
 * An earlier version of this file guessed `peer_name` / `session_name` /
 * `node_id` / `type_term`, by analogy with the request fields that name those
 * things. The server returns the stored ROW, so the keys are the column
 * names: `name` and `id`. Nothing errored -- `renderRow` just returned
 * undefined and every list rendered as empty buttons under a header that
 * correctly said "showing 2 of 2".
 *
 * That is the same failure as the missing `content_digest` earlier today: a
 * hand-written mirror of a server type does not fail loudly, it fails as
 * plausible code reading a wrong premise. Worth re-measuring any time these
 * change.
 *
 * `type_term` in particular does NOT come back on a node row. The type lives
 * in the revision's `term_snapshot_json`, and `listNodes` joins only
 * `title`, `revision_no` and `content_digest` from the current revision. A
 * type badge in a node list therefore needs either a second read or a server
 * change -- it cannot be rendered from this row alone.
 */
export type PeerRow = { name: string; created_at: string };
export type SessionRow = { name: string; created_at: string; is_active: boolean };
export type NodeRow = {
  id: string;
  workspace_name: string;
  current_revision_id: string;
  title: string;
  revision_no: string;
  content_digest: string;
  created_at: string;
  updated_at: string;
  /** #29 slice B (lifecycle-v1.md amendment 2026-09-26): additive on every
   *  row, in both modes -- "active" is a real answer, not an absence of one. */
  lifecycle_state: "active" | "retired" | "superseded";
  /** The successor's node id when `lifecycle_state === "superseded"`, else null. */
  new_id: string | null;
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
  /** Fix-round finding (#33 a11y slice): a 401/403 (or any other real
   *  failure that is not "this route does not exist") used to collapse into
   *  `{rows:[], supported:true}` -- the same shape as a genuinely empty
   *  page -- and the caller had no way left to tell "zero rows" from "the
   *  server refused to answer". `error` carries the governed code (or
   *  `HTTP ${status}` when there is no envelope) for exactly that case;
   *  `null` on success AND on "unsupported", since those two already have
   *  their own signal (`rows`/`supported`). */
  error: string | null;
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
    const unsupported = isUnsupported(result);
    return {
      rows: [],
      nextCursor: null,
      total: null,
      supported: !unsupported,
      // `result.error` is a thrown-fetch (transport) message; prefer it,
      // then the governed envelope code, then the bare status -- the same
      // fallback order `describe()` uses in `useMemory.ts`/`useKnowledge.ts`.
      error: unsupported ? null : (result.error ?? asError(result.body)?.code ?? `HTTP ${result.status}`),
    };
  }
  // A 2xx whose body is not an object (`null`, a bare value) is a malformed
  // answer, not an empty listing: say so rather than throw (ui-reads2 -- the
  // throw skipped the caller's land() and latched "loading") or show zero.
  if (result.body === null || typeof result.body !== "object") {
    return { rows: [], nextCursor: null, total: null, supported: true, error: "malformed listing response (no body)" };
  }
  const body = result.body as Record<string, unknown>;
  const rows = Array.isArray(body.rows) ? (body.rows as T[]) : [];
  const nextCursor = typeof body[cursorKey] === "string" ? (body[cursorKey] as string) : null;
  const total = typeof body.total === "string" ? body.total : null;
  return { rows, nextCursor, total, supported: true, error: null };
}

/** `include_total` is ALWAYS sent, never omitted.
 *
 * The first version spread it in only when true, which is the ergonomic
 * default in most APIs and wrong in this one: this kernel's request grammar
 * is closed and has no optional-key concept, so every field is
 * required-but-nullable and a missing key is `missing_field`, not a default.
 * Omitting it produced `missing_field at /include_total` on every call --
 * the same mismatch the isolation proof hit for the same reason.
 */
export async function listPeers(
  b: Bank,
  afterName: string | null,
  limit: number,
  includeTotal: boolean,
): Promise<Page<PeerRow>> {
  const result = await call(b, "listPeers", {
    after_name: afterName,
    limit,
    include_total: includeTotal,
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
    include_total: includeTotal,
  });
  return toPage<SessionRow>(result, "next_after_name");
}

export async function listNodes(
  b: Bank,
  afterId: string | null,
  limit: number,
  includeTotal: boolean,
  typeTerm: string | null,
  includeInactive: boolean,
): Promise<Page<NodeRow>> {
  const result = await call(b, "listNodes", {
    after_id: afterId,
    limit,
    include_total: includeTotal,
    // Sent ALWAYS, `null` when unfiltered — same closed-grammar rule as
    // `include_total`. Spreading it in only when non-null produced
    // `missing_field at /type_term`, which the UI rendered as an ordinary
    // empty list: "no nodes" over a server holding five. The count strip
    // said "— NODES" at the same time, which was the only visible hint.
    type_term: typeTerm,
    // #29 slice B (lifecycle-v1.md amendment 2026-09-26): closed, required,
    // same rule. `false` is the ordinary view (retired/superseded excluded);
    // `true` is history mode, wired to the EXPLORE "show history" toggle.
    include_inactive: includeInactive,
  });
  return toPage<NodeRow>(result, "next_after_id");
}
