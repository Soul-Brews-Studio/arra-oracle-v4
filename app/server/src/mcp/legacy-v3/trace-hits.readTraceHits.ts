/**
 * The read half of `trace-hits.buildTraceHits.ts`: reconstructs v3's
 * `found_*` arrays for `oracle_trace_get` from a trace's stored `hits` plus
 * its `h_metadata.legacy` block.
 */

const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export type TraceFoundArrays = {
  found_files: unknown[];
  found_commits: unknown[];
  found_issues: unknown[];
  found_retrospectives: unknown[];
  found_learnings: unknown[];
  found_resonance: unknown[];
};

/** Read `found_*` back for `oracle_trace_get`: files/retrospectives/
 *  learnings/resonance verbatim from `legacy`; commits/issues rebuilt from
 *  the indexed hits (representable) followed by `legacy`'s unrepresentable
 *  ones (a v3 change: v3 kept one array in insertion order; the adapter's
 *  split store cannot reproduce that interleaving, so hit position order
 *  wins for the representable prefix). */
export function readTraceHits(legacy: Record<string, unknown> | null, hits: readonly Record<string, unknown>[]): TraceFoundArrays {
  const l = legacy ?? {};
  const commits: unknown[] = [];
  const issues: unknown[] = [];
  for (const hit of hits) {
    // `target` is the stored CANONICAL JSON TEXT (`trace.encodeTraceHitRow.ts`
    // keeps it a string on purpose: "re-parsing it here would invent a shape
    // the wire contract does not define for a read path"). THIS reader is
    // exactly that shape, so it parses -- once, here, never further upstream.
    let target: Record<string, unknown> | undefined;
    try {
      target = typeof hit.target === "string" ? (JSON.parse(hit.target) as Record<string, unknown>) : undefined;
    } catch {
      target = undefined;
    }
    if (hit.kind === "commit" && target !== undefined) {
      const commit = target.commit as Record<string, unknown> | undefined;
      const oid = typeof commit?.oid === "string" ? commit.oid : "";
      const ref = typeof hit.ref === "string" ? hit.ref : oid;
      commits.push({
        hash: oid,
        shortHash: ref !== oid ? ref : oid.slice(0, 7),
        message: hit.excerpt ?? null,
        date: typeof hit.note === "string" ? hit.note.replace(/^date=/, "") : null,
      });
    } else if (hit.kind === "issue" && target !== undefined) {
      const number = Number(target.number);
      issues.push({
        number: Number.isFinite(number) ? number : target.number,
        title: hit.excerpt ?? null,
        state: typeof hit.note === "string" ? hit.note.replace(/^state=/, "") : null,
        url: target.url ?? null,
      });
    }
  }
  return {
    found_files: arrayOf(l.found_files),
    found_commits: [...commits, ...arrayOf(l.unrepresentable_commits)],
    found_issues: [...issues, ...arrayOf(l.unrepresentable_issues)],
    found_retrospectives: arrayOf(l.found_retrospectives),
    found_learnings: arrayOf(l.found_learnings),
    found_resonance: arrayOf(l.found_resonance),
  };
}
