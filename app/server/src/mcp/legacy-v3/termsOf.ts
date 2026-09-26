export type ParsedTerms = {
  /** The reserved `type` vocabulary's term name. Every accepted revision has
   *  exactly one (`service.deriveNodeType.ts`'s kernel-side rule). */
  type: string;
  /** A `legacy_type` term, when the adapter recorded one (V3-PARITY.md §4.3
   *  oracle_list's "other types become type_term:'note' plus a legacy_type
   *  filter"). Compat display prefers this over `type` when present, matching
   *  `oracle_supersede`'s own `old_type`/`new_type` rule. */
  legacyType: string | null;
  /** `concepts` terms, in snapshot order. */
  concepts: string[];
  /** A `project` term, or `null` when this revision never assigned one. */
  project: string | null;
  /** A `memory_horizon` term, or `null`. */
  horizon: string | null;
};

/**
 * Every v3-adapter-relevant field a revision's `term_snapshot_json` carries
 * (V3-PARITY.md §4.3), read the ONLY way an adapter tool may: through the
 * accepted revision's own snapshot text, never a second kernel call. This is
 * adapter-side JSON reading, not a governed codec -- the kernel already
 * validated this exact string at publish time.
 */
export function termsOf(termSnapshotJson: string): ParsedTerms {
  const entries = JSON.parse(termSnapshotJson) as { vocabulary_name_snapshot: string; term_name_snapshot: string }[];
  let type: string | null = null;
  let legacyType: string | null = null;
  let project: string | null = null;
  let horizon: string | null = null;
  const concepts: string[] = [];
  for (const entry of entries) {
    switch (entry.vocabulary_name_snapshot) {
      case "type":
        type = entry.term_name_snapshot;
        break;
      case "legacy_type":
        legacyType = entry.term_name_snapshot;
        break;
      case "concepts":
        concepts.push(entry.term_name_snapshot);
        break;
      case "project":
        project = entry.term_name_snapshot;
        break;
      case "memory_horizon":
        horizon = entry.term_name_snapshot;
        break;
      default:
        break;
    }
  }
  if (type === null) throw new Error("termsOf: an accepted revision always carries exactly one type term");
  return { type, legacyType, concepts, project, horizon };
}
