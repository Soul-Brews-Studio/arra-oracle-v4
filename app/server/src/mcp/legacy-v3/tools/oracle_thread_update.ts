import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { derivedId } from "../ids.derivedId";
import { randomId } from "../ids.randomId";
import { requireThread } from "../requireThread";
import { resolveSpeaker } from "../resolveSpeaker";
import { threadName } from "../threadName";
import { threadTitle } from "../threadTitle";

type Closed = { outcome: "closed" | "idempotent" | "conflict"; reason?: string; row: Record<string, unknown> };

/**
 * `oracle_thread_update` (V3-PARITY.md §4.4; v3 src/tools/forum.ts:101-112,
 * 317-331). A thread is open or closed, and closing is one way (K9
 * `closeSession`, DECISIONS.md R18 D7), recorded with who closed it and why.
 *
 *  - closed: the speaker must be a CURRENT member; a thread already closed
 *    answers the same success with nothing written.
 *  - active: a no-op on an open thread; on a closed one, refused with a
 *    pointer at oracle_thread(reopen:true) -- v4 never reactivates.
 *  - answered, pending: the documented `semantic_refusal`. They were never
 *    states, only derived reply status.
 *  - a missing thread is an error, never v3's success (forum defect D1).
 */
export async function oracle_thread_update(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { tool } = context;
  const name = threadName(context, args.threadId);
  if (args.status === "answered" || args.status === "pending") {
    throw new CompatError(tool, "semantic_refusal", `status ${args.status} is not stored in v4`,
      "a thread is open or closed; whether it awaits a reply is derived from its messages and each reader's cursor", { path: "/status" });
  }
  if (args.status !== "active" && args.status !== "closed") {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /status", "status is active or closed", { path: "/status" });
  }
  const row = await requireThread(context, name);
  const answer = (status: string, message: string) => ({ success: true, thread_id: name, status, title: threadTitle(row), message });

  if (args.status === "active") {
    if (row.is_active === true) return answer("active", `Thread ${name} is open`);
    throw new CompatError(tool, "semantic_refusal", `Thread ${name} is closed and v4 never reopens a session; continue it with oracle_thread(reopen:true)`,
      "closing is one way; a continuation is a new thread linked 'continues' to this one", { path: "/status" });
  }
  if (row.is_active !== true) return answer("closed", `Thread ${name} is already closed`);

  const speaker = resolveSpeaker(context, args);
  if (speaker === null) {
    throw new CompatError(tool, "speaker_required", "closing a thread needs a speaking peer: send the X-Arra-Peer header or pass peer",
      "the close records which member closed it");
  }
  const key = typeof args.idempotency_key === "string" && args.idempotency_key !== "" ? args.idempotency_key : null;
  const reason = typeof args.reason === "string" && args.reason.trim() !== "" ? args.reason : "closed with oracle_thread_update";
  let closed: Closed;
  try {
    closed = (await context.kb("closeSession", {
      session_name: name,
      reason,
      peer_name: speaker,
      operation_id: `v3-close:${key === null ? randomId() : derivedId(context.bank, "close", name, key)}`,
    })) as Closed;
  } catch (error) {
    const e = error as { code?: unknown; path?: unknown };
    if (e.code === "invalid_reference" && e.path === "/peer_name") {
      throw new CompatError(tool, "semantic_refusal", `${speaker} is not a member of thread ${name}; only a member can close it`,
        "the closing peer must hold current membership of the thread");
    }
    throw error;
  }
  if (closed.outcome === "conflict" && closed.reason === "operation_digest") {
    throw new CompatError(tool, "semantic_refusal", "this idempotency_key already closed the thread with another reason",
      "a close is recorded once; its retry key cannot restate it", { path: "/idempotency_key" });
  }
  // closed, idempotent, or already_closed by a concurrent caller: the thread is closed.
  return { ...answer("closed", `Thread ${name} closed`), v4: { session_name: name, outcome: closed.outcome } };
}
