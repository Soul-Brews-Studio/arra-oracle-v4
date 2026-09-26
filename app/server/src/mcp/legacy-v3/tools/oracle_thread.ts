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
import { speakerIsMember } from "../speakerIsMember";
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
 *    speaker, post, then join each `to` peer.
 *  - continue: the speaker must already be a member; `join:true` joins
 *    first. Never a silent join: under R3 membership is read access.
 *  - closed: refused, pointing at `reopen:true`, which a CURRENT member may
 *    use to start a NEW thread linked `continues` to the old one, carrying
 *    its current members over (K10) and saying so. v4 never reactivates a
 *    session.
 *
 * Order is the guarantee: every refusal a read can decide (arguments,
 * speaker binding, recipients, the thread, reopen membership) comes before
 * any write; the speaker peer is registered only then; and nobody but the
 * speaker is joined until the post is stored. A refused call adds nobody.
 *
 * `oracle_response` is always null: v4 does not auto-answer (v3 promised it
 * and never did, forum defect D6). An `idempotency_key` derives the session
 * and message ids, so a retry replays instead of posting twice (A8). The key
 * is the SPEAKER's: every id it derives includes the speaker, so two oracles
 * that pick the same key never meet in one thread.
 */
export async function oracle_thread(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const input = threadPostArgs(context, args);
  const existing = args.threadId === undefined || args.threadId === null ? null : threadName(context, args.threadId);
  const named = resolveSpeaker(context, args);
  if (named === null) {
    throw new CompatError(context.tool, "speaker_required", "oracle_thread needs a speaking peer: send the X-Arra-Peer header or pass peer",
      "a post is authored by a peer, and v4 never derives one from the credential, the user-agent or cwd");
  }
  await requireRecipients(context, input.to);
  const { bank, tool } = context;
  const warnings = [...input.warnings];

  let row: Record<string, unknown> | null = null;
  let members: Awaited<ReturnType<typeof carriedMembers>> | null = null;
  if (existing !== null) {
    row = await requireThread(context, existing);
    if (row.is_active !== true) {
      if (!input.reopen) {
        throw new CompatError(tool, "semantic_refusal", `Thread ${existing} is closed; pass reopen:true to continue it in a new thread`,
          "a closed session takes no new messages and is never reactivated", { path: "/threadId" });
      }
      // Read AS the speaker: a non-member is refused here, before any write.
      members = await carriedMembers(context, existing, named);
    } else if (!input.join && !(await speakerIsMember(context, existing, named))) {
      // The kernel refuses this post anyway; asking first keeps the refusal
      // ahead of every write, the speaker's own registration included.
      throw new CompatError(tool, "semantic_refusal", `${named} is not a member of thread ${existing}; pass join:true to join it`,
        "membership is the read boundary (R3), so v4 never joins a speaker silently");
    }
  }

  const speaker = (await ensureSpeaker(context, args))!;
  const keyed = (...parts: string[]) => (input.key === null ? randomId() : derivedId(bank, ...parts, speaker, input.key));
  let session: string;
  let continues: string | null = null;
  let invite: readonly string[] = input.to;
  if (existing === null) {
    session = await openThread(context, { sessionId: keyed("session", tool), title: input.title, speaker });
  } else if (members === null) {
    session = existing;
    if (input.reopen) warnings.push({ code: "argument_ignored", field: "reopen", detail: `thread ${existing} is open; the post goes to it` });
    if (input.join) {
      const joined = (await context.kb("joinSession", { session_name: existing, peer_name: speaker })) as Registered;
      if (joined.outcome === "conflict") {
        throw new CompatError(tool, "semantic_refusal", `${speaker} left thread ${existing} and v4 has no rejoin`, "a departed membership is terminal through this interface");
      }
    }
  } else {
    session = await openThread(context, { sessionId: keyed("session", tool, existing), title: input.title ?? threadTitle(row!), speaker });
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
    invite = [...members.carried, ...input.to];
    warnings.push({ code: "semantic_change", field: "thread_id", detail: `thread ${existing} is closed and v4 never reopens a session; this post starts thread ${session}, linked 'continues' to it` });
    if (members.skipped.length > 0) {
      warnings.push({ code: "partial", field: "members", detail: `not carried over: ${members.skipped.join(", ")} (this credential may not act as them); each can join with join:true` });
    }
    if (!members.complete) warnings.push({ code: "partial", field: "members", detail: "only the first 1000 members were carried over" });
  }

  // The kernel checks the speaker's CURRENT membership on the post itself.
  const posted = await postMessage(context, { session, speaker, content: input.message, role: input.role, publicId: keyed("message", tool, session) });
  // Only now does anyone else join: the post proved the speaker a member of
  // this thread, so a stranger's (or a colliding key's) refused post never
  // adds anyone. A keyed replay joins its `to` again, idempotently; a peer it
  // newly names is one the speaker, a member, could invite with any post.
  const departed: string[] = [];
  for (const peer of new Set(invite)) {
    if (peer === speaker) continue;
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
