import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

export type Warning = { code: string; field: string; detail: string };

export type ThreadPostArgs = {
  message: string;
  role: string | null;
  title: string | null;
  to: string[];
  join: boolean;
  reopen: boolean;
  key: string | null;
  warnings: Warning[];
};

/**
 * `oracle_thread`'s arguments, checked before anything is read or written.
 *
 * v3's own input rule stays: a nonblank message (content is NOT trimmed; v4
 * applies no normalization). `role` passes through verbatim or stays null --
 * v3's three disagreeing defaults (forum defect D5) are not reproduced, so no
 * role is invented. `model` has no carrier yet (K12b) and is named as ignored,
 * never silently dropped.
 */
export function threadPostArgs(context: V3ToolContext, args: Record<string, unknown>): ThreadPostArgs {
  const refuse = (path: string, detail: string): never => {
    throw new CompatError(context.tool, "unsupported_argument", `Invalid input at ${path}: ${detail}`, detail, { path });
  };
  const optionalString = (field: string): string | null => {
    const value = args[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || value.trim() === "") return refuse(`/${field}`, `${field} must be a nonblank string`);
    return value;
  };
  const flag = (field: string): boolean => {
    const value = args[field];
    if (value === undefined || value === null) return false;
    if (typeof value !== "boolean") return refuse(`/${field}`, `${field} must be a boolean`);
    return value;
  };

  if (typeof args.message !== "string" || args.message.trim() === "") refuse("/message", "message is required and must not be blank");
  const to: string[] = [];
  if (args.to !== undefined && args.to !== null) {
    if (!Array.isArray(args.to)) refuse("/to", "to must be an array of peer names");
    (args.to as unknown[]).forEach((peer, index) => {
      if (typeof peer !== "string" || peer.trim() === "") refuse(`/to/${index}`, "each recipient must be a peer name");
      if (!to.includes(peer as string)) to.push(peer as string);
    });
  }
  const warnings: Warning[] = [];
  if (args.model !== undefined && args.model !== null) {
    warnings.push({ code: "argument_ignored", field: "model", detail: "v4 stores no model per message yet (K12b); the post is kept without it" });
  }
  return {
    message: args.message as string,
    role: optionalString("role"),
    title: optionalString("title"),
    to,
    join: flag("join"),
    reopen: flag("reopen"),
    key: optionalString("idempotency_key"),
    warnings,
  };
}
