import { createHash } from "node:crypto";

/**
 * A deterministic nanoid21 for an adapter-created row (V3-PARITY.md §3 A4,
 * A8): vocabulary, term and peer ids from their scoped names, so a replayed
 * create answers `already_satisfied`; node and operation ids from an
 * `idempotency_key`, so a client retry replays instead of duplicating.
 *
 *   base64url(sha256("arra-v3-compat/1\n" + bank + "\n" + parts.join("\n")))[0:21]
 *
 * A different domain from D1's legacy node ids (`ids.legacyNodeId.ts`), so
 * the two can never collide by construction.
 */
export function derivedId(bank: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(["arra-v3-compat/1", bank, ...parts].join("\n"), "utf8").digest();
  return digest.toString("base64url").slice(0, 21);
}
