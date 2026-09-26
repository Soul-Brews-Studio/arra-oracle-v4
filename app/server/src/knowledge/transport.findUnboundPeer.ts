import { parseStrictBytes, type JcsValue } from "../contracts/jcs";
import type { PeerFieldPath } from "./registry.peerFields";

/** Same governed limits `peekWorkspaceName` applies to the same bytes. */
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;

/**
 * The JSON pointer of the first caller-asserted peer (#87 / R3) that the
 * grant's `peers` binding does not list, or null when every one is bound.
 *
 * Pure and storage-free; the caller turns a pointer into the 403. Parses the
 * ORIGINAL request bytes with the governed strict parser -- the same bytes the
 * kernel will parse -- so a duplicate key cannot show this check one peer and
 * the kernel another. Only STRING values are judged: a missing, null or
 * wrong-typed field asserts no peer here and is left to the kernel's own
 * grammar, which rejects it with its usual governed error.
 *
 * Fields are visited in declared order and array elements in index order, so
 * the reported pointer is deterministic. Path tokens are fixed literal keys
 * (no `~` or `/`), so no RFC 6901 escaping is needed.
 */
export function findUnboundPeer(
  bytes: Uint8Array,
  fields: readonly PeerFieldPath[],
  peers: readonly string[],
): string | null {
  if (fields.length === 0) return null;
  const root = parseStrictBytes(bytes, [], { maxBytes: MAX_BYTES, maxDepth: MAX_DEPTH });
  for (const path of fields) {
    const found = walk(root, path, "");
    if (found !== null) return found;
  }
  return null;

  function walk(node: JcsValue, rest: readonly string[], pointer: string): string | null {
    if (rest.length === 0) return typeof node === "string" && !peers.includes(node) ? pointer : null;
    const [token, ...tail] = rest;
    if (token === "*") {
      if (!Array.isArray(node)) return null;
      for (let i = 0; i < node.length; i++) {
        const found = walk(node[i]!, tail, `${pointer}/${i}`);
        if (found !== null) return found;
      }
      return null;
    }
    if (!(node instanceof Map)) return null;
    const next = node.get(token!);
    return next === undefined ? null : walk(next, tail, `${pointer}/${token}`);
  }
}
