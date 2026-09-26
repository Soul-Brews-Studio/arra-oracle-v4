import { carriedMembers } from "../carriedMembers";
import { CompatError } from "../compat-error";
import { ensureSpeaker } from "../ensureSpeaker";
import type { V3ToolContext } from "../handlers";
import { derivedId } from "../ids.derivedId";
import { randomId } from "../ids.randomId";
import { openThread } from "../openThread";
import { postMessage } from "../postMessage";
import { requireRecipients } from "../requireRecipients";
import { requireThread } from "../requireThread";
import { resolveSpeaker } from "../resolveSpeaker";
import { threadName } from "../threadName";
import { threadPostArgs } from "../threadPostArgs";
import { threadTitle } from "../threadTitle";

type Registered = { outcome: string; reason?: string };

/**
 * `oracle_thread` (V3-PARITY.md §4.3; v3 src/tools/forum.ts:57-72,126-207):
 * post to a thread, starting one when no threadId is given. A thread is a v4
 * session, a post is a message, and the speaker (A7/D8: the `peer` argument
 * or X-Arra-Peer, bound by the grant) is its author and a member -- that is
 * how oracles register as entities and talk like a channel.
 *
 *  - new: register the session (title = K12a display metadata), join the
 *    speaker and each `to` peer, post.
 *  - continue: the speaker must already be a member; `join:true` joins
 *    first. Never a silent join: under R3 membership is read access.
 *  - closed: refused, pointing at `reopen:true`, which starts a NEW thread
 *    linked `continues` to the old one, carries its current members over
 *    (K10) and says so. v4 never reactivates a session.
 *
 * `oracle_response` is always null: v4 does not auto-answer (v3 promised it
 * and never did, forum defect D6). An `idempotency_key` derives the session
 * and message ids, so a retry replays instead of posting twice (A8).
 */
export async function oracle_thread(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const input = threadPostArgs(context, args);
  const existing = args.threadId === undefined || args.threadId === null ? null : threadName(context, args.threadId);
  // The speaker is resolved (and bound-checked) before any write; it is
  // registered only once every refusal has had its chance.
  if (resolveSpeaker(context, args) === null) {
    throw new CompatError(context.tool, "speaker_required", "oracle_thread needs a speaking peer: send the X-Arra-Peer header or pass peer",
      "a post is authored by a peer, and v4 never derives one from the credential, the user-agent or cwd");
  }
  await requireRecipients(context, input.to);
  const speaker = (await ensureSpeaker(context, args))!;
  const { bank, tool } = context;
  const warnings = [...input.warnings];
  const messageId = (session: string) => (input.key === null ? randomId() : derivedId(bank, "message", tool, session, input.key));

  let session: string;
  let continues: string | null = null;
  let invite: readonly string[] = [];
  if (existing === null) {
    session = await openThread(context, {
      sessionId: input.key === null ? randomId() : derivedId(bank, "session", tool, input.key),
      title: input.title,
      speaker,
      members: input.to,
    });
  } else {
    const row = await requireThread(context, existing);
    if (row.is_active === true) {
      session = existing;
      if (input.reopen) warnings.push({ code: "argument_ignored", field: "reopen", detail: `thread ${existing} is open; the post goes to it` });
      if (input.join) {
        const joined = (await context.kb("joinSession", { session_name: existing, peer_name: speaker })) as Registered;
        if (joined.outcome === "conflict") {
          throw new CompatError(tool, "semantic_refusal", `${speaker} left thread ${existing} and v4 has no rejoin`, "a departed membership is terminal through this interface");
        }
      }
      // Recipients join only AFTER the post proved the speaker a member, so
      // a stranger's refused post never adds anyone to the thread.
      invite = input.to;
    } else if (!input.reopen) {
      throw new CompatError(tool, "semantic_refusal", `Thread ${existing} is closed; pass reopen:true to continue it in a new thread`,
        "a closed session takes no new messages and is never reactivated", { path: "/threadId" });
    } else {
      const members = await carriedMembers(context, existing, speaker);
      session = await openThread(context, {
        sessionId: input.key === null ? randomId() : derivedId(bank, "session", tool, existing, input.key),
        title: input.title ?? threadTitle(row),
        speaker,
        members: [...members.carried, ...input.to],
      });
      const linked = (await context.kb("createSessionLink", {
        id: derivedId(bank, "link", session, existing),
        from_session_name: session,
        to_session_name: existing,
        relation: "continues",
        evidence_ref: null,
        created_by_peer_name: speaker,
      })) as Registered;
      if (linked.outcome === "conflict") {
        throw new CompatError(tool, "semantic_refusal", `thread ${session} already continues a different thread`, "v4 answered conflict creating the continues link");
      }
      continues = existing;
      warnings.push({ code: "semantic_change", field: "thread_id", detail: `thread ${existing} is closed and v4 never reopens a session; this post starts thread ${session}, linked 'continues' to it` });
      if (members.skipped.length > 0) {
        warnings.push({ code: "partial", field: "members", detail: `not carried over: ${members.skipped.join(", ")} (this credential may not act as them); each can join with join:true` });
      }
      if (!members.complete) warnings.push({ code: "partial", field: "members", detail: "only the first 1000 members were carried over" });
    }
  }

  const posted = await postMessage(context, { session, speaker, content: input.message, role: input.role, publicId: messageId(session) });
  const departed: string[] = [];
  for (const peer of invite) {
    const joined = (await context.kb("joinSession", { session_name: session, peer_name: peer })) as Registered;
    if (joined.outcome === "conflict") departed.push(peer);
  }
  if (departed.length > 0) {
    warnings.push({ code: "partial", field: "to", detail: `posted, but not added: ${departed.join(", ")} left this thread and v4 has no rejoin` });
  }
  return {
    thread_id: session,
    message_id: posted.message_id,
    status: "active",
    oracle_response: null,
    issue_url: null,
    compat_warnings: warnings,
    v4: { session_name: session, seq: posted.seq, outcome: posted.outcome, ...(continues === null ? {} : { continues }) },
  };
}
