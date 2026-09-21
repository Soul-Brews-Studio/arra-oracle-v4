import { failPublication } from "./errors";

/**
 * The configured namespace must be valid BEFORE a connection is opened.
 *
 * Nonempty only. There is deliberately NO byte ceiling here: the accepted
 * source codec does not impose one, and the request cap is not a
 * namespace-specific name bound. Inventing a 256-byte limit would be this
 * module adding a rule the contract does not state.
 */
export function assertSourceNamespace(namespace: string | null): void {
  if (namespace === null) return;
  if (typeof namespace !== "string" || namespace.length === 0) {
    failPublication("invalid_request", "/sourceNamespace");
  }
}
