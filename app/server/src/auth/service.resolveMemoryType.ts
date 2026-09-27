import type { RequestAuthority } from "../knowledge/registry";
import type { StoreDependencies } from "./service.types";

/**
 * D5a HTTP parity (#31 AC-MATRIX row 111): `insertMemory`'s `deps.validateType`
 * call, split out of `service.ts` to stay under this repo's per-file line cap.
 * The same sealed `type` vocabulary MCP `remember` enforces, run here too so a
 * caller cannot reach an invented/retired type through the HTTP twin instead.
 * `deps.validateType` absent (an isolated `insert`-only test composition)
 * passes `type` through unchanged, same as before D5a.
 */
export function resolveMemoryType(
  deps: StoreDependencies,
  bank: string,
  peers: readonly string[] | null,
  type: string | undefined,
): Promise<string | undefined> {
  if (!deps.validateType) return Promise.resolve(type);
  const authority: RequestAuthority = Object.freeze({ operator: false, peers });
  return deps.validateType(bank, authority, type);
}
