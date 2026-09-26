import { CompatError } from "../compat-error";
import { countMatches } from "../countMatches";
import { excerptOf } from "../excerptOf";
import type { V3ToolContext } from "../handlers";
import { lookupTermIdByName } from "../lookupTermIdByName";
import { pageArgsOf } from "../pageArgsOf";
import { pageByOffset } from "../pageByOffset";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_PREVIEW_CODE_POINTS = 500;

type Warning = { code: string; field: string; detail: string };

/**
 * `oracle_inbox` (2 real calls; content:read; V3-PARITY.md §5/§7 K3+K4, V6).
 * Handoffs in this bank: every node tagged `concepts:handoff`
 * (`oracle_handoff`'s own write), newest-updated first (K4's `order:
 * "updated_desc"`, done inside the kernel scan via K3's `any_term_ids`
 * instead of a directory listing v3 read). `type: "all"` is v3 dialect for
 * `"handoff"` until K10/K11 add unread messages to it (V3-PARITY.md §4.4).
 */
export async function oracle_inbox(args: Record<string, unknown>, context: V3ToolContext): Promise<unknown> {
  const { bank, kb, tool } = context;
  const { limit, offset } = pageArgsOf(tool, args, DEFAULT_LIMIT, MAX_LIMIT);

  const rawType = args.type === undefined || args.type === null ? "handoff" : args.type;
  if (rawType !== "handoff" && rawType !== "all") {
    throw new CompatError(tool, "unsupported_argument", "Invalid input at /type", "only 'handoff' and 'all' are v3 dialect for this tool", { path: "/type" });
  }

  const warnings: Warning[] = [
    { code: "field_unavailable", field: "path", detail: "v4 writes no file; there is no inbox directory to report a path in" },
  ];
  if (rawType === "all") {
    warnings.push({ code: "semantic_change", field: "type", detail: "'all' behaves exactly like 'handoff' until K10/K11 add unread messages" });
  }

  const handoffTermId = await lookupTermIdByName(kb, "concepts", "handoff");
  if (handoffTermId === null) {
    return { files: [], total: 0, limit, offset, compat_warnings: warnings };
  }

  const requestBase = { workspace_name: bank, any_term_ids: [handoffTermId], type_term: null, order: "updated_desc" as const };
  const { rows, truncated } = await pageByOffset(kb, requestBase, offset, limit);
  if (truncated) {
    warnings.push({ code: "truncated", field: "offset", detail: "offset walks at most 10 kernel pages of 100; this offset is beyond that reach" });
  }

  // `oracle_inbox`'s v3 shape has a non-nullable `total`, unlike
  // `oracle_list`'s -- `listNodes`'s own native total is null under ANY term
  // filter (K3), so this counts by a second, exhaustive walk instead
  // (`countMatches`). An inbox with more handoffs than that walk reaches is
  // the one case `total` is honestly `null`, named below.
  const counted = await countMatches(kb, requestBase);
  if (!counted.exhausted) {
    warnings.push({ code: "partial", field: "total", detail: "more handoffs exist than the bounded count walk reached; total is not exact" });
  }

  const files: Record<string, unknown>[] = [];
  for (const row of rows) {
    const head = (await kb("getAcceptedHead", { node_id: row.id })) as { revision: Record<string, unknown> } | null;
    if (head === null) continue;
    files.push({
      filename: head.revision.title,
      path: null,
      created: row.created_at,
      preview: excerptOf(head.revision.body as string, MAX_PREVIEW_CODE_POINTS),
      type: "handoff",
    });
  }

  return { files, total: counted.exhausted ? counted.total : null, limit, offset, compat_warnings: warnings };
}
