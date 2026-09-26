import { readFileSync } from "node:fs";
import { ARGFILE_PREFIX } from "./argv.constants";

/**
 * Child side of the argv spill (see `argv.spillOversizedArgs.ts`): the text a
 * parent meant to pass, whether it arrived inline or was spilled to a file
 * because it was over the inline limit. `undefined` stays `undefined`, so a
 * child's existing `?? "{}"` default keeps working.
 */
export function readArgPayload(arg: string | undefined): string | undefined {
  if (arg === undefined || !arg.startsWith(ARGFILE_PREFIX)) return arg;
  return readFileSync(arg.slice(ARGFILE_PREFIX.length), "utf8");
}
