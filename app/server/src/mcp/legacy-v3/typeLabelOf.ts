import { readTermSnapshot } from "./readTermSnapshot";

/**
 * v3's `type` string for one node revision (V3-PARITY.md §4.3 oracle_supersede:
 * "old_type/new_type come from the type term, or from legacy_type if present").
 * A5 maps every v3 type except `learning` onto `note` plus a `legacy_type`
 * term carrying the original string, so `legacy_type` -- when present -- is
 * the more informative, v3-faithful label; a node the adapter itself
 * published never carries both a non-`note` `type` and a `legacy_type`.
 *
 * Falls back to `"note"` (never throws) for a revision published with no
 * `type` term at all, which cannot happen through this adapter (A4 always
 * seeds one) but can for a node published through `kb_publishRevision`
 * directly.
 */
export function typeLabelOf(revision: Record<string, unknown>): string {
  const snapshot = revision.term_snapshot_json;
  return readTermSnapshot(snapshot, "legacy_type") ?? readTermSnapshot(snapshot, "type") ?? "note";
}
