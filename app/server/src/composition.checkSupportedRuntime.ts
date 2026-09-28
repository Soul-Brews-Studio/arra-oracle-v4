import { SUPPORTED_BUN, SUPPORTED_ELYSIA, type VersionCheck } from "./composition.constants";
import { readInstalledElysiaVersion } from "./composition.readInstalledElysiaVersion";

/**
 * Validate the installed runtime versions, reading both by DEFAULT.
 *
 * The earlier version only checked Elysia when a version was passed in, so the
 * real startup path never checked it at all while the tests — which did pass
 * one — made it look covered. Both are now read from the installed runtime by
 * default and both fail closed when absent.
 */
export function checkSupportedRuntime(
  bunVersion: string | undefined = typeof Bun === "undefined" ? undefined : Bun.version,
  elysiaVersion: string | undefined = readInstalledElysiaVersion(),
): VersionCheck {
  if (bunVersion !== SUPPORTED_BUN) {
    return { ok: false, reason: `unsupported Bun runtime: expected ${SUPPORTED_BUN}` };
  }
  if (elysiaVersion === undefined) {
    return { ok: false, reason: "could not determine the installed Elysia version" };
  }
  if (elysiaVersion !== SUPPORTED_ELYSIA) {
    return { ok: false, reason: `unsupported Elysia version: expected ${SUPPORTED_ELYSIA}` };
  }
  return { ok: true };
}
