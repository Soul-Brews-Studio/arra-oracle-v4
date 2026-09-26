import { CompatError } from "./compat-error";
import { fromKernel } from "./compat-error.fromKernel";

type Envelope = { code: string; path: string; toJSON(): unknown };

const isEnvelope = (error: unknown): error is Envelope =>
  typeof error === "object" &&
  error !== null &&
  typeof (error as { code?: unknown }).code === "string" &&
  typeof (error as { path?: unknown }).path === "string" &&
  typeof (error as { toJSON?: unknown }).toJSON === "function";

/**
 * The error `oracle_search_chain` ends with when a hop's trace cannot be
 * written. Traces are immutable, so the hops written before it stand; the
 * refusal names them rather than hiding them behind a bare `kernel_error`
 * (the caller could not otherwise find or reuse them). With nothing written
 * yet, or for a wiring fault that is no governed error, it is unchanged.
 */
export function chainStopped(tool: string, error: unknown, written: readonly string[]): unknown {
  if (written.length === 0) return error;
  const base = error instanceof CompatError ? error : isEnvelope(error) ? fromKernel(tool, error) : null;
  if (base === null) return error;
  return new CompatError(tool, base.code, base.message, `${base.detail}; the hops before it were written and stand as traces ${written.join(", ")}`, {
    path: base.path,
    v4Error: base.v4Error,
  });
}
