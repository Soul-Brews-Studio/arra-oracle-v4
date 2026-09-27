import type { CliOptions } from "./parseFlags";

/**
 * Resolve the raw request bytes for `kb <method>`, from exactly ONE of
 * `--json` (the literal command-line text), `--file` (raw file bytes) or
 * `--stdin` (raw stdin bytes). Never `JSON.parse`d and never re-serialized:
 * `knowledge/transport.ts`'s governed parser is the only thing allowed to
 * read structure out of these bytes, so this CLI must not collapse a
 * duplicate-key body before it gets there (that is the exact fault the
 * governed parser exists to reject, and a `JSON.parse` round trip here would
 * silently do it first).
 */
export async function readKbRequestBody(options: CliOptions): Promise<Uint8Array> {
  const sources = (["json", "file", "stdin"] as const).filter((key) => Object.hasOwn(options, key));
  if (sources.length !== 1) {
    throw new Error("exactly one of --json, --file or --stdin is required");
  }
  if (options.json !== undefined) return new TextEncoder().encode(options.json);
  if (options.file !== undefined) return new Uint8Array(await Bun.file(options.file).arrayBuffer());
  return new Uint8Array(await Bun.stdin.arrayBuffer());
}
