import { randomBytes } from "node:crypto";

/** Matches `contracts/common.ts`'s `isNanoid21` grammar: 21 URL-safe chars. */
const NANOID21_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

/**
 * Mint a 21-character id matching this codebase's nanoid21 wire grammar, for
 * alias commands whose kernel method takes a CALLER-supplied id
 * (`registerPeer`'s `peer_id`, `registerSession`'s `session_id`,
 * `appendMessages`' per-item `public_id`) that the alias would otherwise have
 * to demand as a required flag. Modulo bias against 256 is harmless here --
 * these are allocation identifiers, not a security boundary -- matching
 * `knowledge/transport.ts`'s own `randomNanoid21`, which mints revision ids
 * server-side; this is the CLI's own copy for ids a CALLER mints instead.
 */
export function randomNanoid21(): string {
  const raw = randomBytes(21);
  let out = "";
  for (let i = 0; i < 21; i++) out += NANOID21_ALPHABET[raw[i]! % NANOID21_ALPHABET.length];
  return out;
}
