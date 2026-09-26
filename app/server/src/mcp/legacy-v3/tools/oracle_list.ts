import { CompatError } from "../compat-error";
import { countMatches } from "../countMatches";
import { documentOf, type LifecycleEvent } from "../documentOf";
import type { V3ToolContext } from "../handlers";
import { lookupTermIdByName } from "../lookupTermIdByName";
import { pageArgsOf } from "../pageArgsOf";
import { pageByOffset } from "../pageByOffset";

/** v3's own default (arra-oracle-v3@61e5f8b6 src/tools/list.ts). */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

type Warning = { code: string; field: string; detail: string };

/**
 * `oracle_list` (2 real calls; content:read; V3-PARITY.md §4.3 V2-degraded,
 * §5/§7 V6 full with K3+K4). Browse mode: history included, flagged
 * (`include_inactive: true`), newest-updated first (K4). `type: "learning"`
 * becomes `type_term`; any other `type` becomes `type_term: "note"` plus a
 * K3 `any_term_ids` filter on the matching `legacy_type` term, done INSIDE
 * the kernel's own scan instead of the "applied after the page" degraded
 * behaviour the V2 design used before K3 existed.
 *
 * Fix round (Opus verifier): v3's own `type` enum is `['principle','pattern',
 * 'learning','retro','all']`, `default:'all'` (arra-oracle-v3@61e5f8b6
 * src/tools/list.ts) -- `'all'` IS v3's spelling of "no filter", the same as
 * omitting the key, never a `legacy_type` NAME to look up. Before this fix
 * `'all'` was looked up as a legacy_type term, found null, and returned an
 * empty page -- silent data loss for a documented, DEFAULT v3 argument.
 * `asOf` is handled here too: V3-PARITY.md §4.3 says it "returns
 * unsupported_argument, because there is no historical browse" -- refused,
 * never silently read-and-ignored.
 *
 * R18 D3 fix round: browse keeps every node, but each row the RECALL tools
 * would drop is flagged with the kernel's own `getRecallEligibility` reasons
 * (`ineligible_reasons`, see `documentOf.ts`) -- one kernel call per row, so
 * the flag and the recall filter are the same rule at request time, never a
 * copy of it here. A non-string or blank `type` is refused, as v3 refused it
 * (`type must be a string` / not in its enum), instead of silently reading
 * as "all".
 */
export async function oracle_list(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { bank, kb, tool } = context;
  const { limit, offset } = pageArgsOf(tool, args, DEFAULT_LIMIT, MAX_LIMIT);

  if (args.asOf !== undefined && args.asOf !== null) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /asOf", "there is no historical browse in v4; asOf is refused rather than silently ignored", { path: "/asOf" });
  }

  if (args.type !== undefined && args.type !== null && (typeof args.type !== "string" || args.type.trim() === "")) {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /type", "type must be a nonblank string; omit it (or pass 'all') for no filter", { path: "/type" });
  }
  const rawType = typeof args.type === "string" ? args.type.trim() : null;
  const typeArg = rawType === "all" ? null : rawType;

  const warnings: Warning[] = [
    { code: "field_unavailable", field: "source_file", detail: "v4 writes no file; there is no path to report" },
  ];

  let type_term: string | null = null;
  let any_term_ids: string[] | null = null;
  if (typeArg !== null) {
    if (typeArg === "learning") {
      type_term = "learning";
    } else {
      type_term = "note";
      const legacyTypeId = await lookupTermIdByName(kb, "legacy_type", typeArg);
      if (legacyTypeId === null) {
        return { documents: [], total: 0, limit, offset, type: typeArg, compat_warnings: warnings };
      }
      any_term_ids = [legacyTypeId];
    }
  }

  // `any_term_ids` is an OPTIONAL key (K3): present-with-`null` is refused,
  // so it is only added to the request object when there is a real filter --
  // omitting it entirely is how "no filter" is spelled on this wire.
  const requestBase: Record<string, unknown> = { workspace_name: bank, include_inactive: true, order: "updated_desc", type_term };
  if (any_term_ids !== null) requestBase.any_term_ids = any_term_ids;

  const { rows, total, truncated } = await pageByOffset(kb, requestBase, offset, limit);
  if (truncated) {
    warnings.push({ code: "truncated", field: "offset", detail: "offset walks at most 10 kernel pages of 100; this offset is beyond that reach" });
  }
  // `listNodes`'s native total is null under ANY type/legacy_type filter
  // (K3) -- the SAME gap `oracle_inbox` already closes with a bounded,
  // exhaustive walk (`countMatches`) instead of reporting `null` whenever an
  // exact count is actually reachable within that bound.
  let exactTotal = total;
  if (exactTotal === null) {
    const counted = await countMatches(kb, requestBase);
    if (counted.exhausted) exactTotal = String(counted.total);
  }
  if (exactTotal === null) {
    warnings.push({ code: "partial", field: "total", detail: "more documents exist than the bounded count walk reached; total is not exact" });
  }

  const documents: Record<string, unknown>[] = [];
  for (const row of rows) {
    const head = (await kb("getAcceptedHead", { node_id: row.id })) as { revision: Record<string, unknown> } | null;
    if (head === null) continue; // listNodes just returned this id; a concurrent write is the only way, and it is not this row's problem to report.
    let lifecycleEvent: LifecycleEvent | null = null;
    if (row.lifecycle_state !== "active") {
      const history = (await kb("listLifecycleHistory", { node_id: row.id, after_event_id: null, limit: 1 })) as { rows: LifecycleEvent[] };
      lifecycleEvent = history.rows[0] ?? null;
    }
    const eligibility = (await kb("getRecallEligibility", { node_id: row.id })) as { eligible: boolean; reasons: string[] };
    documents.push(documentOf(row, head, lifecycleEvent, eligibility.eligible ? [] : eligibility.reasons));
  }

  return {
    documents,
    total: exactTotal === null ? null : Number(exactTotal),
    limit,
    offset,
    // `rawType` (not the "all"-normalized `typeArg`) so an explicit
    // `type:"all"` still echoes "all", the same as an omitted `type` does.
    type: rawType ?? "all",
    compat_warnings: warnings,
  };
}
