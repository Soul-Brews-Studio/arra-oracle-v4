import { type Bank } from "./memory";
import { type Page, type NodeRow } from "./listing";
import { call } from "./listing.call";
import { toPage } from "./listing.toPage";

export async function listNodes(
  b: Bank,
  afterId: string | null,
  limit: number,
  includeTotal: boolean,
  typeTerm: string | null,
  includeInactive: boolean,
): Promise<Page<NodeRow>> {
  const result = await call(b, "listNodes", {
    after_id: afterId,
    limit,
    include_total: includeTotal,
    // Sent ALWAYS, `null` when unfiltered — same closed-grammar rule as
    // `include_total`. Spreading it in only when non-null produced
    // `missing_field at /type_term`, which the UI rendered as an ordinary
    // empty list: "no nodes" over a server holding five. The count strip
    // said "— NODES" at the same time, which was the only visible hint.
    type_term: typeTerm,
    // #29 slice B (lifecycle-v1.md amendment 2026-09-26): closed, required,
    // same rule. `false` is the ordinary view (retired/superseded excluded);
    // `true` is history mode, wired to the EXPLORE "show history" toggle.
    include_inactive: includeInactive,
  });
  return toPage<NodeRow>(result, "next_after_id");
}
