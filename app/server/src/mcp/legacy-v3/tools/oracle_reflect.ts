import { CompatError } from "../compat-error";
import type { V3ToolContext } from "../handlers";
import { randomId } from "../ids.randomId";
import { lookupTermIdByName } from "../lookupTermIdByName";
import { termsOf } from "../termsOf";

type ListNodesPage = { rows: Record<string, unknown>[]; next_after_id: string | null };

/** Kernel pages one walk may follow before giving up on a pool: each
 *  `listNodes` call examines up to `MAX_SCANNED_NODES` (1000) nodes, so this
 *  reaches 10,000 nodes past the random start, and as many again after the
 *  wrap -- the same "at most 10 kernel pages" bound `pageByOffset` uses. */
const MAX_DRAW_PAGES = 10;

/**
 * `oracle_reflect` (0 real calls; content:read; V3-PARITY.md §4.3, §7 V6).
 * The recall path (R18 D3, V3-PARITY A6): every draw asks `listNodes` for
 * its `eligible_only` view, so a node the kernel's own eligibility check
 * rejects -- retired, superseded, a head with `is_active: false`, or outside
 * its validity window at request time -- is never drawn. Fix round (v3-list,
 * Opus verifier): this tool previously relied on `listNodes`'s DEFAULT view,
 * which drops only retired/superseded nodes, and drew forgotten and expired
 * learnings. A random nanoid21 as the keyset cursor picks an arbitrary
 * starting point in id order; the walk follows `next_after_id` past scan
 * windows that held no match (a sparse pool), then wraps to `after_id:
 * null` once, both bounded by `MAX_DRAW_PAGES`.
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
    const request: Record<string, unknown> = {
      workspace_name: bank, after_id: afterId, limit: 1, include_total: false, type_term: typeTerm, eligible_only: true,
    };
    if (anyTermIds !== null) request.any_term_ids = anyTermIds;
    return kb("listNodes", request) as Promise<ListNodesPage>;
  };
  // A page with no row but a `next_after_id` is a full scan window that held
  // no match, not the end of the pool: keep walking (verifier finding: a
  // sparse pool used to read as empty after one window each way).
  const walk = async (typeTerm: "learning" | "note", anyTermIds: string[] | null, start: string | null) => {
    let afterId = start;
    for (let page = 0; page < MAX_DRAW_PAGES; page += 1) {
      const result = await draw(typeTerm, anyTermIds, afterId);
      if (result.rows.length > 0) return result.rows[0]!;
      if (result.next_after_id === null) return null;
      afterId = result.next_after_id;
    }
    return null;
  };
  const sample = async (typeTerm: "learning" | "note", anyTermIds: string[] | null): Promise<Record<string, unknown> | null> =>
    (await walk(typeTerm, anyTermIds, randomId())) ?? (await walk(typeTerm, anyTermIds, null));

  const principleTermId = await lookupTermIdByName(kb, "legacy_type", "principle");
  const [learningRow, principleRow] = await Promise.all([
    sample("learning", null),
    principleTermId === null ? Promise.resolve(null) : sample("note", [principleTermId]),
  ]);

  const row = learningRow !== null && principleRow !== null
    ? (Math.random() < 0.5 ? learningRow : principleRow)
    : (learningRow ?? principleRow);
  if (row === null) {
    throw new CompatError(tool, "no_results", "No learnings in this bank yet", "no recall-eligible learning or principle in this workspace returns no_results in v4; v3 threw");
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
