import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGFILE_PREFIX, ARGV_INLINE_MAX_BYTES } from "./argv.constants";

/**
 * Parent side of the argv spill: every argument over `ARGV_INLINE_MAX_BYTES`
 * UTF-8 bytes is written to a 0600 file and replaced by `ARGFILE_PREFIX +
 * path`; a child reads it back with `readArgPayload`. Arguments at or under
 * the limit pass through untouched, so ordinary calls look exactly as before.
 *
 * The directory is created only when something spills, and `cleanup` removes
 * exactly that directory -- the one this call created, never one found by
 * prefix. Call it once the child has exited.
 */
export function spillOversizedArgs(args: string[]): { args: string[]; cleanup: () => void } {
  let dir: string | null = null;
  const out = args.map((arg, index) => {
    if (Buffer.byteLength(arg, "utf8") <= ARGV_INLINE_MAX_BYTES) return arg;
    dir ??= mkdtempSync(join(tmpdir(), "arra-argv-spill-"));
    const path = join(dir, `arg-${index}.txt`);
    writeFileSync(path, arg, { encoding: "utf8", mode: 0o600 });
    return `${ARGFILE_PREFIX}${path}`;
  });
  return {
    args: out,
    cleanup: () => {
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      dir = null;
    },
  };
}
