import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { randomId } from "../ids.randomId";
import { termsOf } from "../termsOf";

type ListNodesRow = { rows: Record<string, unknown>[] };

/**
 * `oracle_reflect` (0 real calls; content:read; V3-PARITY.md §4.3). The
 * recall path (D3): `listNodes`'s default view already excludes retired and
 * superseded nodes (#29), so "eligible only" needs no extra kernel call here.
 * A random nanoid21 as the keyset cursor picks an arbitrary starting point in
 * id order; wrapping to `after_id: null` once covers the case where nothing
 * sorts after it.
 */
export async function oracle_reflect(_args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { bank, kb, tool } = context;
  const draw = (afterId: string | null) =>
    kb("listNodes", { workspace_name: bank, after_id: afterId, limit: 1, include_total: false, type_term: "learning" }) as Promise<ListNodesRow>;

  let page = await draw(randomId());
  if (page.rows.length === 0) page = await draw(null);
  if (page.rows.length === 0) {
    throw new CompatError(tool, "no_results", "No learnings in this bank yet", "an empty workspace returns no_results in v4; v3 threw");
  }

  const row = page.rows[0]!;
  const head = (await kb("getAcceptedHead", { node_id: row.id })) as { revision: Record<string, unknown> };
  const parsed = termsOf(head.revision.term_snapshot_json as string);

  return {
    principle: {
      id: row.id,
      type: parsed.legacyType ?? parsed.type,
      content: head.revision.body,
      source_file: null,
      concepts: parsed.concepts,
    },
    compat_warnings: [
      { code: "field_unavailable", field: "source_file", detail: "v4 writes no file; there is no path to report" },
      {
        code: "partial",
        field: "principle",
        detail: "v3 also sampled a distinct 'principle' type; v4 samples type learning only until a legacy_type:principle mapping exists (K3)",
      },
    ],
  };
}
