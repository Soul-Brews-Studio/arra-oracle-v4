import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

type Registered = { outcome: "created" | "already_satisfied"; row: Record<string, unknown> } | { outcome: "conflict"; reason: string };

/**
 * A new thread: `registerSession` under the name `t-<session id>` -- never
 * derived from the title, which is display metadata (K12a; DESIGN.md:369) --
 * then `joinSession` for the speaker and each other member. Every step is
 * idempotent on stable identity, so a keyed retry replays instead of
 * duplicating. Returns the session name, which is the v3 `thread_id`.
 */
export async function openThread(
  context: V3ToolContext,
  thread: { sessionId: string; title: string | null; speaker: string; members: readonly string[] },
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
  for (const peer of [thread.speaker, ...thread.members.filter((member) => member !== thread.speaker)]) {
    const joined = (await context.kb("joinSession", { session_name: name, peer_name: peer })) as Registered;
    if (joined.outcome === "conflict") {
      throw new CompatError(context.tool, "semantic_refusal", `${peer} left thread ${name} and v4 has no rejoin`,
        "a departed membership is terminal through this interface");
    }
  }
  return name;
}
