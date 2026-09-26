import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

/**
 * A3: a v4 thread id is a session NAME, a string. v3's integer ids name
 * threads that were never imported (D9), so an integer is `legacy_id_unknown`
 * -- never a lookup that might hit an unrelated session named "42".
 */
export function threadName(context: V3ToolContext, value: unknown): string {
  if (typeof value === "number") {
    throw new CompatError(context.tool, "legacy_id_unknown", `Thread ${value} not found`,
      "v3 thread ids are integers and v3 threads are not imported; a v4 thread id is a session name", { path: "/threadId" });
  }
  if (typeof value !== "string" || value === "") {
    throw new CompatError(context.tool, "unsupported_argument", "Invalid input at /threadId: expected a thread id",
      "threadId is the thread's session name, a nonempty string", { path: "/threadId" });
  }
  return value;
}
