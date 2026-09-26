/**
 * `oracle_handoff` writes every handoff as a v4 node (type `note`, tagged
 * `concepts:handoff`), so K6/K7 count it like any other entry. v3 kept
 * handoffs as inbox files that `oracle_concepts`/`oracle_stats` never saw, so
 * a counted handoff is a `semantic_change` a v3 caller is told about, never a
 * silent shift in its numbers. `rows` is a K6 `listTermUsage` answer for the
 * `concepts` vocabulary; no `handoff` row means nothing to warn about.
 */
export function handoffWarning(
  rows: readonly { name: string; count: string }[],
  field: string,
  counted: string,
): { code: "semantic_change"; field: string; detail: string } | null {
  const handoff = rows.find((row) => row.name === "handoff");
  if (handoff === undefined) return null;
  return {
    code: "semantic_change",
    field,
    detail: `${handoff.count} current entries carry concepts:handoff (oracle_handoff writes one per call) and are counted in ${counted}; v3 kept handoffs as inbox files and never counted them`,
  };
}
