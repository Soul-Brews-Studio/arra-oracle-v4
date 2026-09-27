import { callMethod } from "./client";
import { type Page } from "./listing";
import { type Bank } from "./memory";
import { type McpCallRow } from "./audit";
import { toPage } from "./audit.toPage";

/** Both methods send EVERY key, `null` where there is no filter: the grammar is
 *  closed, so an omitted key is `missing_field`, not a default. `tool`/`status`
 *  null means "no filter", never "match null" -- neither is ever null on a row. */
export async function listMcpCalls(
  b: Bank, afterId: string | null, limit: number, includeTotal: boolean,
  tool: string | null, status: string | null,
): Promise<Page<McpCallRow>> {
  const body = { workspace_name: b.workspace, after_id: afterId, limit, tool, status, include_total: includeTotal };
  return toPage<McpCallRow>(await callMethod(b.bank, "listMcpCalls", body, b.token), "next_after_id");
}
