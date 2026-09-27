import { callMethod } from "./client";
import { type Page } from "./listing";
import { type Bank } from "./memory";
import { type ConnectionRow } from "./audit";
import { toPage } from "./audit.toPage";

export async function listConnections(
  b: Bank, afterId: string | null, limit: number, includeTotal: boolean,
): Promise<Page<ConnectionRow>> {
  const body = { workspace_name: b.workspace, after_id: afterId, limit, include_total: includeTotal };
  return toPage<ConnectionRow>(await callMethod(b.bank, "listConnections", body, b.token), "next_after_id");
}
