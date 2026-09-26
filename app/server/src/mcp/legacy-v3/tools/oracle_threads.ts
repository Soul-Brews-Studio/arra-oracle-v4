import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { resolveSpeaker } from "../resolveSpeaker";
import { threadTitle } from "../threadTitle";

/** v3's own default page size (forum.ts:74-86). */
const DEFAULT_LIMIT = 20;

type Page = { rows: Record<string, unknown>[]; next_after_name: string | null; total: string | null };

/**
 * `oracle_threads` (V3-PARITY.md §4.2; v3 src/tools/forum.ts:74-86,209-236).
 * One `listSessions` page (K10 filters), never a read per thread: v3 read
 * every thread's messages to count them (forum defect D10), so `message_count`
 * and `last_message` are null here and named.
 *
 *  - With a speaker, the list is that speaker's threads (K10
 *    `member_peer_name`, CURRENT memberships), because a thread it cannot read
 *    is noise (R3); `all:true` lists every thread in the bank. Without one,
 *    every thread (names are not secret; messages are).
 *  - `status` active/closed filters exactly (K10 `is_active`); answered and
 *    pending are not stored states in v4 and are refused.
 *  - Ordered by thread id (the session name), not recency, and paged with
 *    `next_cursor` (pass it back as `cursor`), never `offset`.
 */
export async function oracle_threads(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const refuse = (code: "unsupported_argument" | "semantic_refusal", path: string, error: string, detail: string): never => {
    throw new CompatError(context.tool, code, error, detail, { path });
  };
  let isActive: boolean | null = null;
  if (args.status !== undefined && args.status !== null) {
    if (args.status === "answered" || args.status === "pending") {
      refuse("semantic_refusal", "/status", `status ${args.status} is not stored in v4`, "a thread is open or closed; whether it awaits a reply is derived from its messages");
    }
    if (args.status !== "active" && args.status !== "closed") refuse("unsupported_argument", "/status", "Invalid input at /status", "status is active or closed");
    isActive = args.status === "active";
  }
  if (args.offset !== undefined && args.offset !== null && args.offset !== 0) {
    refuse("unsupported_argument", "/offset", "Invalid input at /offset: offset paging is not supported", "pages are keyset cursors: pass next_cursor back as cursor");
  }
  const limit = args.limit === undefined || args.limit === null ? DEFAULT_LIMIT : args.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    refuse("unsupported_argument", "/limit", "Invalid input at /limit", "limit is a whole number, 1..100");
  }
  const cursor = args.cursor === undefined || args.cursor === null ? null : args.cursor;
  if (cursor !== null && (typeof cursor !== "string" || cursor === "")) refuse("unsupported_argument", "/cursor", "Invalid input at /cursor", "cursor is a next_cursor this tool returned");
  if (args.all !== undefined && args.all !== null && typeof args.all !== "boolean") refuse("unsupported_argument", "/all", "Invalid input at /all", "all is a boolean");

  const speaker = resolveSpeaker(context, args);
  const member = args.all === true ? null : speaker;
  // A total over both filters is one count the kernel does not run; it is
  // then null and named, never approximated.
  const withTotal = !(member !== null && isActive !== null);
  const page = (await context.kb("listSessions", {
    after_name: cursor,
    limit: limit as number,
    include_total: withTotal,
    is_active: isActive,
    member_peer_name: member,
  })) as Page;

  const warnings = [
    { code: "order_changed", field: "threads", detail: "ordered by thread id (the session name), not by latest activity" },
    { code: "field_unavailable", field: "message_count", detail: "not counted per thread: that would read every thread's messages (v3 defect D10)" },
    { code: "field_unavailable", field: "last_message", detail: "not read per thread; read the thread with oracle_thread_read" },
  ];
  if (member !== null) {
    warnings.push({ code: "semantic_change", field: "threads", detail: `only threads ${member} belongs to; pass all:true for every thread in this bank` });
  }
  if (!withTotal) warnings.push({ code: "partial", field: "total", detail: "no total for a status filter together with a member filter" });
  return {
    threads: page.rows.map((row) => ({
      id: row.name,
      title: threadTitle(row),
      status: row.is_active === true ? "active" : "closed",
      message_count: null,
      last_message: null,
      created_at: row.created_at,
      issue_url: null,
    })),
    total: page.total === null ? null : Number(page.total),
    next_cursor: page.next_after_name,
    compat_warnings: warnings,
  };
}
