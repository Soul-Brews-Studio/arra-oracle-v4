import { CompatError } from "./compat-error";

type Envelope = { code: string; path: string; toJSON(): unknown };

/** v3-style text per v4 code (docs/overnight/V3-PARITY.md §2.6 table). */
const TEXT: Readonly<Record<string, string>> = Object.freeze({
  invalid_reference: "referenced record not found",
  conflict: "name already taken by a different id",
  writer_unavailable: "Oracle is read-only or busy; retry",
  recovery_required: "Oracle is read-only or busy; retry",
  unsupported_dataset: "knowledge dataset not configured",
  limit_exceeded: "input too large",
  integrity_failure: "internal integrity failure",
  worker_failure: "internal integrity failure",
  forbidden: "this credential may not act as that peer",
});

/**
 * Wrap a governed v4 envelope (`arra-error/v1`, `arra-publication-error/v1`,
 * `arra-taxonomy-error/v1`) that escaped an adapter tool as `kernel_error`,
 * carrying the envelope UNCHANGED in `v4_error`. Format faults read as v3's
 * "Invalid input at <path>".
 */
export function fromKernel(tool: string, error: Envelope): CompatError {
  const where = error.path === "" ? "" : ` at ${error.path}`;
  const known = TEXT[error.code];
  const text = known === undefined ? `Invalid input${where}: ${error.code}` : `${known}${where}`;
  // compat.path points into the caller's v3 arguments; the kernel's own
  // path points into the v4 payload and stays inside v4_error.
  return new CompatError(tool, "kernel_error", text, `v4 answered ${error.code}`, { v4Error: error.toJSON() });
}
