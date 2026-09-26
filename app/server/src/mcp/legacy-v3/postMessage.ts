import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

type Stop = { index: number; error?: { code?: string; path?: string }; conflict?: string };
type Appended = {
  outcome: "complete" | "stopped";
  results: { outcome: string; row: Record<string, unknown> }[];
  stop: Stop | null;
};

/**
 * One post: `appendMessages` with one item, as the speaker. The kernel checks
 * everything -- an active session, the speaker's CURRENT membership, the
 * public_id -- and answers item-level refusals as a `stopped` batch, which is
 * translated here, never ignored:
 *  - not a member: `semantic_refusal`, pointing at `join:true` (the adapter
 *    never joins silently: under R3 joining grants read access);
 *  - the thread closed meanwhile: `semantic_refusal`, pointing at `reopen:true`;
 *  - a public_id held by a different message: the idempotency_key was reused;
 *  - anything else: `kernel_error` carrying the v4 envelope unchanged.
 */
export async function postMessage(
  context: V3ToolContext,
  post: { session: string; speaker: string; content: string; role: string | null; publicId: string },
): Promise<{ message_id: string; seq: string; outcome: string }> {
  const result = (await context.kb("appendMessages", {
    session_name: post.session,
    items: [{ public_id: post.publicId, message: { peer_name: post.speaker, role: post.role, content: post.content, in_reply_to: null }, source: null }],
  })) as Appended;
  const [done] = result.results;
  if (result.outcome === "complete" && done !== undefined) {
    return { message_id: String(done.row.public_id), seq: String(done.row.seq_in_session), outcome: done.outcome };
  }
  const stop = result.stop;
  if (stop?.conflict !== undefined) {
    throw new CompatError(context.tool, "semantic_refusal", "this idempotency_key was already used for a different message",
      "the message id it derives names another message; use a new key", { path: "/idempotency_key" });
  }
  if (stop?.error?.code === "invalid_reference" && stop.error.path === "/items/0/message/peer_name") {
    throw new CompatError(context.tool, "semantic_refusal", `${post.speaker} is not a member of thread ${post.session}; pass join:true to join it`,
      "membership is the read boundary (R3), so v4 never joins a speaker silently");
  }
  if (stop?.error?.code === "invalid_reference" && stop.error.path === "/session_name") {
    throw new CompatError(context.tool, "semantic_refusal", `Thread ${post.session} is closed; pass reopen:true to continue it in a new thread`,
      "a closed session takes no new messages and is never reactivated");
  }
  throw new CompatError(context.tool, "kernel_error", `message refused: ${stop?.error?.code ?? "unknown"}`, `v4 answered ${stop?.error?.code ?? "a stopped batch"}`,
    { v4Error: stop?.error ?? null });
}
