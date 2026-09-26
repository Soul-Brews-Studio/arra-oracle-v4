import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";

/**
 * The session behind a thread id, or the v3-style "Thread X not found" as
 * `no_results`. A missing thread is ALWAYS an error: v3's oracle_thread_update
 * reported success for one (forum defect D1).
 */
export async function requireThread(context: V3ToolContext, name: string): Promise<Record<string, unknown>> {
  const row = (await context.kb("getSession", { session_name: name })) as Record<string, unknown> | null;
  if (row === null) {
    throw new CompatError(context.tool, "no_results", `Thread ${name} not found`, "no session of that name in this bank", { path: "/threadId" });
  }
  return row;
}
