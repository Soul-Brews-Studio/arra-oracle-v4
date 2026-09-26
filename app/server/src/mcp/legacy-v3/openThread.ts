import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";
import { speakerIsMember } from "./speakerIsMember";

type Registered = { outcome: "created" | "already_satisfied"; row: Record<string, unknown> } | { outcome: "conflict"; reason: string };

/**
 * A new thread: `registerSession` under the name `t-<session id>` -- never
 * derived from the title, which is display metadata (K12a; DESIGN.md:369) --
 * then `joinSession` for the SPEAKER alone. Returns the session name, which
 * is the v3 `thread_id`. Anyone else (`to`, carried members) is joined by the
 * caller only AFTER the post is stored, so a refused post leaves no one in a
 * thread they did not ask for.
 *
 * `already_satisfied` means the name exists. A keyed session id is derived
 * from the speaker AND the key, so this is the speaker's own replay -- and it
 * is accepted only while the speaker is still a CURRENT member. A session
 * that holds the name without the speaker (registered by someone else, or by
 * a first attempt that stopped before its join) is refused with no join at
 * all: under R3 joining grants read access, so v4 joins nobody into a thread
 * this call did not create.
 */
export async function openThread(
  context: V3ToolContext,
  thread: { sessionId: string; title: string | null; speaker: string },
): Promise<string> {
  const name = `t-${thread.sessionId}`;
  const registered = (await context.kb("registerSession", {
    session_id: thread.sessionId,
    name,
    ...(thread.title === null ? {} : { h_metadata: { title: thread.title } }),
  })) as Registered;
  if (registered.outcome === "conflict") {
    throw new CompatError(context.tool, "semantic_refusal", "this idempotency_key already names a different thread",
      `v4 answered conflict (${registered.reason}) registering ${name}`, { path: "/idempotency_key" });
  }
  // A keyed replay of a thread that was closed since: it stays closed.
  if (registered.row.is_active !== true) {
    throw new CompatError(context.tool, "semantic_refusal", `Thread ${name} is closed; pass reopen:true to continue it in a new thread`,
      "a closed session takes no new messages and is never reactivated", { path: "/idempotency_key" });
  }
  if (registered.outcome === "already_satisfied") {
    if (!(await speakerIsMember(context, name, thread.speaker))) {
      throw new CompatError(context.tool, "semantic_refusal", `this idempotency_key names thread ${name}, which ${thread.speaker} is not a member of; use a new key`,
        "a keyed replay is accepted only into the speaker's own thread, and v4 joins nobody into a thread this call did not create", { path: "/idempotency_key" });
    }
    return name;
  }
  const joined = (await context.kb("joinSession", { session_name: name, peer_name: thread.speaker })) as Registered;
  if (joined.outcome === "conflict") {
    throw new CompatError(context.tool, "semantic_refusal", `${thread.speaker} left thread ${name} and v4 has no rejoin`,
      "a departed membership is terminal through this interface");
  }
  return name;
}
