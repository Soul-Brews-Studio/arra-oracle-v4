import { createHash } from "node:crypto";

/**
 * D1 (docs/overnight/DECISIONS.md R18, V3-PARITY.md §3 A3): the node id a
 * legacy (v4-spike `memories`) id maps to.
 *
 *   base64url(sha256("arra-legacy-node/v1\n" + ws + "\n" + id))[0:21]
 *
 * UTF-8, no padding. #34's migration must derive byte-identical ids; the
 * known answers in `test/mcp-v3-frame.test.ts` were computed with Python's
 * hashlib, not with this function.
 */
export function legacyNodeId(workspace: string, legacyId: string): string {
  const digest = createHash("sha256").update(`arra-legacy-node/v1\n${workspace}\n${legacyId}`, "utf8").digest();
  return digest.toString("base64url").slice(0, 21);
}
