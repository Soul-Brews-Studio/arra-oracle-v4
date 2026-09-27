import type { CiteTarget } from "./linkDraft.types";

/** Newest-seen first, one entry per revision id, at most `cap`. Feeds the
 *  link editor's "pick a loaded revision" list, so citing another node means
 *  opening it once rather than copying two 21-character ids by hand. */
export function mergeCiteTargets(existing: CiteTarget[], incoming: CiteTarget[], cap = 20): CiteTarget[] {
  const seen = new Set<string>();
  const out: CiteTarget[] = [];
  for (const target of [...incoming, ...existing]) {
    if (seen.has(target.revision_id)) continue;
    seen.add(target.revision_id);
    out.push(target);
    if (out.length === cap) break;
  }
  return out;
}
