import { CompatError } from "./compat-error";

const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

type Kb = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Resolve a caller's `traceId` to a v4 trace row (A3, D9).
 *
 * Traces have no legacy derivation -- D1's scheme is node-only, and a v3
 * trace is a server-generated UUID, never a caller-chosen id a v4 hash could
 * reproduce. A well-formed nanoid21 is looked up directly (absence is a
 * plain `null`, exactly like `getTrace` itself); anything else -- a real v3
 * UUID, an integer-as-text -- is `legacy_id_unknown` at once: no v3 trace
 * corpus is imported (D9), so it can never resolve.
 */
export async function resolveTraceId(kb: Kb, id: unknown, tool: string): Promise<Record<string, unknown> | null> {
  if (typeof id !== "string" || id === "") {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /traceId: traceId is required", "traceId must be a nonempty string", { path: "/traceId" });
  }
  if (!NANOID21.test(id)) {
    throw new CompatError(tool, "legacy_id_unknown", `Trace ${id} not found`, "v3 trace ids do not exist in v4 (no v3 corpus import, D9)", { path: "/traceId" });
  }
  return (await kb("getTrace", { id })) as Record<string, unknown> | null;
}
