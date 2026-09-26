import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

/**
 * A7 / D8: who speaks on this call, decided WITHOUT writing anything, so a
 * read tool can use it too. The tool argument `peer` wins, then the
 * connection's X-Arra-Peer; both are caller ASSERTIONS, so under a grant
 * `peers` binding the name must be listed (the header was already checked by
 * the service; the argument is checked here). Never derived from the bearer,
 * the user-agent or cwd. Null means no speaker.
 */
export function resolveSpeaker(context: V3ToolContext, args: Record<string, unknown>): string | null {
  if (!Object.hasOwn(args, "peer") || args.peer === null || args.peer === undefined) return context.assertedPeer;
  if (typeof args.peer !== "string" || args.peer.trim() === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /peer: expected a peer name", "peer must be a nonblank string", { path: "/peer" });
  }
  const bound = context.authority.peers;
  if (bound !== null && !bound.includes(args.peer)) {
    throw new CompatError(context.tool, "unsupported_argument", `peer ${args.peer} is not bound to this credential`,
      "this credential's grant lists the peers it may speak as, and this is not one of them", { path: "/peer" });
  }
  return args.peer;
}
