import { CompatError } from "./compat-error";
import { legacyNodeId } from "./ids.legacyNodeId";

const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

type Kb = (method: string, payload: Record<string, unknown>) => Promise<unknown>;

/**
 * Resolve a caller's id to a node (D1, V3-PARITY.md §3 A3).
 *
 * A nanoid21 is tried as a direct node id; every id is also tried through the
 * legacy derivation. Exactly one hit wins. Both hitting is refused, never
 * guessed: the caller named two different nodes with one string. Neither
 * hitting is `null` for a nanoid21 (an ordinary "not found") and
 * `legacy_id_unknown` for anything else -- v3 ids (`learning_...`, UUIDs,
 * integers-as-text) do not exist in v4 until an explicit import (D9).
 */
export async function resolveNodeId(
  kb: Kb,
  bank: string,
  id: string,
  tool: string,
): Promise<{ node_id: string; head: unknown } | null> {
  const derived = legacyNodeId(bank, id);
  const direct = NANOID21.test(id) ? await kb("getAcceptedHead", { node_id: id }) : null;
  const legacy = derived === id ? null : await kb("getAcceptedHead", { node_id: derived });
  if (direct !== null && legacy !== null) {
    throw new CompatError(tool, "semantic_refusal", `Ambiguous id: ${id}`, "both a node with this id and a node derived from it as a legacy id exist; refusing to guess", { path: "/id" });
  }
  if (direct !== null) return { node_id: id, head: direct };
  if (legacy !== null) return { node_id: derived, head: legacy };
  if (NANOID21.test(id)) return null;
  throw new CompatError(tool, "legacy_id_unknown", `Document not found: ${id}`, "v3 ids do not exist in v4 (no v3 corpus import, D9)", { path: "/id" });
}
