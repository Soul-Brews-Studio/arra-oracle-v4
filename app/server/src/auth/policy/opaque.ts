import { reject } from "./reject";
import type { AuthErrorCode } from "./types";

/**
 * Run a shared contract helper and discard everything it says on failure. The
 * helpers raise precise pointers and messages by design; surfacing those here
 * would leak policy structure and values into a public authentication error.
 */
export function opaque<T>(run: () => T, code: AuthErrorCode): T {
  try {
    return run();
  } catch {
    return reject(code);
  }
}
