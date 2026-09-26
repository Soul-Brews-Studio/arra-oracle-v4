import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { readThreadMessages } from "../readThreadMessages";
import { requireThread } from "../requireThread";
import { resolveSpeaker } from "../resolveSpeaker";
import { threadName } from "../threadName";
import { threadTitle } from "../threadTitle";

/** v3 read every message; v4 walks at most 1000 forward, or reads a tail this long. */
const MAX_LIMIT = 1000;

/**
 * `oracle_thread_read` (V3-PARITY.md §4.2; v3 src/tools/forum.ts:88-99,
 * 271-281). The thread's messages in seq order, read AS the speaking peer:
 * membership is the read boundary (R3), so a non-member is refused. With no
 * speaker only the audit:read operator view may read; otherwise the answer
 * is `speaker_required`. `limit` is honoured (v3's HTTP twin dropped it,
 * forum defect D7) and means v3's "last N", read as one tail page (K11).
 *
 * `message_count` is exact when the read reached both ends of the thread,
 * otherwise null and named. A message stored with no role keeps null (no
 * invented default, forum defect D5), named too. Reading never moves a read
 * cursor (read-cursor-v1.md:10).
 */
export async function oracle_thread_read(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const name = threadName(context, args.threadId);
  let limit: number | null = null;
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIMIT) {
      throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /limit", `limit is a whole number of messages, 1..${MAX_LIMIT}`, { path: "/limit" });
    }
    limit = args.limit;
  }
  const speaker = resolveSpeaker(context, args);
  if (speaker === null && !context.authority.operator) {
    throw new CompatError(context.tool, "speaker_required", "oracle_thread_read needs a speaking peer: send the X-Arra-Peer header or pass peer",
      "a thread is read as one of its members (R3); only an audit:read credential reads without naming one");
  }
  const row = await requireThread(context, name);
  const read = await readThreadMessages(context, { session: name, requester: speaker, limit });

  const warnings: { code: string; field: string; detail: string }[] = [];
  const count = read.exhausted ? read.rows.length : null;
  if (count === null) {
    warnings.push({ code: "field_unavailable", field: "message_count", detail: limit === null
      ? "the thread has more than 1000 messages; page on with next_cursor"
      : "the tail did not reach the first message, so the thread's full count is not known from this read" });
  }
  if (limit === null && !read.exhausted) warnings.push({ code: "truncated", field: "messages", detail: "the first 1000 messages; next_cursor continues" });
  const messages = read.rows.map((message) => ({
    id: message.public_id,
    seq: message.seq_in_session,
    role: message.role,
    author: message.peer_name,
    content: message.content,
    timestamp: message.created_at,
  }));
  if (messages.some((message) => message.role === null)) {
    warnings.push({ code: "field_unavailable", field: "messages[].role", detail: "posted with no role; v4 keeps null rather than invent one" });
  }
  return {
    thread_id: name,
    title: threadTitle(row),
    status: row.is_active === true ? "active" : "closed",
    message_count: count,
    messages,
    next_cursor: read.next_after_seq,
    compat_warnings: warnings,
    v4: { session_name: name, read_as: speaker },
  };
}
