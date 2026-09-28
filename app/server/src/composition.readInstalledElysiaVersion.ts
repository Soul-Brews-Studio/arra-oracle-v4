import { createRequire } from "node:module";

/**
 * Read the INSTALLED Elysia version from its package metadata.
 *
 * Reads only; it edits no manifest and no lockfile, both of which are frozen.
 * Returns undefined when the metadata cannot be read, which the caller treats
 * as unsupported rather than as "skip the check".
 */
export function readInstalledElysiaVersion(): string | undefined {
  try {
    const require_ = createRequire(import.meta.url);
    const metadata = require_("elysia/package.json") as { version?: unknown };
    return typeof metadata.version === "string" ? metadata.version : undefined;
  } catch {
    return undefined;
  }
}
