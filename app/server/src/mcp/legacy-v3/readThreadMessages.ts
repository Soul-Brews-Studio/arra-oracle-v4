import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

type Row = Record<string, unknown>;
type Page = { rows: Row[]; next_after_seq?: string | null; next_before_seq?: string | null };

/** Page size of each listMessages call, and pages walked at most (1000 messages). */
const PAGE = 100;
const MAX_PAGES = 10;

/**
 * A thread's messages, read AS the requester (R3: membership is the read
 * boundary; null is the audit:read operator view, which the caller checked).
 *
 *  - `limit` null (v3's "all"): walk forward from the start, at most 1000
 *    messages; `exhausted` says whether the walk reached the end.
 *  - `limit` N (v3's "last N"): read the tail directly with K11
 *    (`direction:"desc"`), newest first, then return it in seq order;
 *    `exhausted` says whether the tail reached the FIRST message, which is
 *    the only case where the returned count is the thread's whole count.
 *
 * Reading never moves a read cursor: nothing here writes.
 */
export async function readThreadMessages(
  context: V3ToolContext,
  thread: { session: string; requester: string | null; limit: number | null },
): Promise<{ rows: Row[]; exhausted: boolean; next_after_seq: string | null }> {
  const read = async (payload: Record<string, unknown>): Promise<Page> => {
    try {
      return (await context.kb("listMessages", {
        session_name: thread.session,
        ...(thread.requester === null ? {} : { requester_peer_name: thread.requester }),
        ...payload,
      })) as Page;
    } catch (error) {
      const e = error as { code?: unknown; path?: unknown };
      if (e.code === "invalid_reference" && e.path === "/requester_peer_name") {
        throw new CompatError(context.tool, "semantic_refusal", `${thread.requester} is not a member of thread ${thread.session}`,
          "membership is the read boundary (R3): only a current member reads a thread's messages");
      }
      throw error;
    }
  };

  const rows: Row[] = [];
  if (thread.limit === null) {
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await read({ after_seq: after, limit: PAGE });
      rows.push(...result.rows);
      after = result.next_after_seq ?? null;
      if (after === null) return { rows, exhausted: true, next_after_seq: null };
    }
    return { rows, exhausted: false, next_after_seq: after };
  }
  let before: string | null = null;
  while (rows.length < thread.limit) {
    const result = await read({ after_seq: null, limit: Math.min(PAGE, thread.limit - rows.length), direction: "desc", before_seq: before });
    rows.push(...result.rows);
    before = result.next_before_seq ?? null;
    if (before === null) return { rows: rows.reverse(), exhausted: true, next_after_seq: null };
  }
  return { rows: rows.reverse(), exhausted: false, next_after_seq: null };
}
