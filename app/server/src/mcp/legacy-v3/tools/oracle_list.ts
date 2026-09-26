import { documentOf, type LifecycleEvent } from "../documentOf";
import type { V3ToolContext } from "../handlers";
import { lookupTermIdByName } from "../lookupTermIdByName";
import { pageArgsOf } from "../pageArgsOf";
import { pageByOffset } from "../pageByOffset";

const DEFAULT_LIMIT = 20;
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
 */
export async function oracle_list(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { bank, kb, tool } = context;
  const { limit, offset } = pageArgsOf(tool, args, DEFAULT_LIMIT, MAX_LIMIT);
  const typeArg = typeof args.type === "string" && args.type.trim() !== "" ? args.type.trim() : null;

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
  if (total === null) {
    warnings.push({ code: "partial", field: "total", detail: "no native scoped count exists once a type/legacy_type filter is set" });
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
    documents.push(documentOf(row, head, lifecycleEvent));
  }

  return {
    documents,
    total: total === null ? null : Number(total),
    limit,
    offset,
    type: typeArg ?? "all",
    compat_warnings: warnings,
  };
}
