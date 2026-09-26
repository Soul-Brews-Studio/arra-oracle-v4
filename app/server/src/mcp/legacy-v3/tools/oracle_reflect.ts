import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { randomId } from "../ids.randomId";
import { lookupTermIdByName } from "../lookupTermIdByName";
import { termsOf } from "../termsOf";

type ListNodesRow = { rows: Record<string, unknown>[] };

/**
 * `oracle_reflect` (0 real calls; content:read; V3-PARITY.md §4.3, §7 V6).
 * The recall path (D3): `listNodes`'s default view already excludes retired
 * and superseded nodes (#29), so "eligible only" needs no extra kernel call
 * here. A random nanoid21 as the keyset cursor picks an arbitrary starting
 * point in id order; wrapping to `after_id: null` once covers the case
 * where nothing sorts after it.
 *
 * K3 upgrade (overnight R18, fix round): v3 sampled BOTH `principle` and
 * `learning` (v3 `reflect.ts`, `RANDOM()` over the two). v4 has no reserved
 * `principle` type, so a principle is `type_term:"note"` plus the adapter's
 * own `legacy_type:"principle"` tag -- the SAME mapping `oracle_list`'s
 * `type` filter already uses -- now expressible INSIDE `listNodes`'s own
 * scan via K3's `any_term_ids`, instead of the learning-only sampling this
 * tool shipped with before K3 existed. `listNodes` has no primitive for a
 * union of two independent type filters in one call, so this draws from each
 * pool separately and, when both have at least one eligible row, a coin flip
 * decides which draw wins -- an approximation of v3's single `RANDOM()` over
 * the union, not an exact reproduction of its distribution.
 */
export async function oracle_reflect(_args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { bank, kb, tool } = context;
  const draw = (typeTerm: "learning" | "note", anyTermIds: string[] | null, afterId: string | null) => {
    const request: Record<string, unknown> = { workspace_name: bank, after_id: afterId, limit: 1, include_total: false, type_term: typeTerm };
    if (anyTermIds !== null) request.any_term_ids = anyTermIds;
    return kb("listNodes", request) as Promise<ListNodesRow>;
  };
  const sample = async (typeTerm: "learning" | "note", anyTermIds: string[] | null): Promise<Record<string, unknown> | null> => {
    let page = await draw(typeTerm, anyTermIds, randomId());
    if (page.rows.length === 0) page = await draw(typeTerm, anyTermIds, null);
    return page.rows[0] ?? null;
  };

  const principleTermId = await lookupTermIdByName(kb, "legacy_type", "principle");
  const [learningRow, principleRow] = await Promise.all([
    sample("learning", null),
    principleTermId === null ? Promise.resolve(null) : sample("note", [principleTermId]),
  ]);

  const row = learningRow !== null && principleRow !== null
    ? (Math.random() < 0.5 ? learningRow : principleRow)
    : (learningRow ?? principleRow);
  if (row === null) {
    throw new CompatError(tool, "no_results", "No learnings in this bank yet", "an empty workspace returns no_results in v4; v3 threw");
  }

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
    ],
  };
}
