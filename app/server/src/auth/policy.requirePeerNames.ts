import { utf8ByteLength } from "../contracts/jcs";
import type { JcsValue } from "../contracts/jcs";
import { MAX_PEERS_PER_GRANT, MAX_PEER_NAME_BYTES } from "./policy.constants";
import { reject } from "./policy.reject";
import { requireArrayValue } from "./policy.requireArrayValue";

/**
 * A grant's `peers` binding (#87 / R3). Each entry uses the context kernel's
 * peer-name grammar -- nonempty, at most 256 UTF-8 bytes, no trim, no case
 * fold -- so a binding can name every peer the kernel can store and nothing it
 * cannot. Duplicates are checked with the other per-principal duplicates in
 * `parsePolicy`, not here, matching the contract's cross-cutting order.
 */
export function requirePeerNames(value: JcsValue): string[] {
  const raw = requireArrayValue(value);
  // Collection limits precede element validation.
  if (raw.length > MAX_PEERS_PER_GRANT) reject("policy_invalid");
  const peers: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) reject("policy_invalid");
    if (utf8ByteLength(entry) > MAX_PEER_NAME_BYTES) reject("policy_invalid");
    peers.push(entry);
  }
  return peers;
}
