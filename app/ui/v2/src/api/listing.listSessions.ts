import { type Bank } from "./memory";
import { type Page, type SessionRow } from "./listing";
import { call } from "./listing.call";
import { toPage } from "./listing.toPage";

export async function listSessions(
  b: Bank,
  afterName: string | null,
  limit: number,
  includeTotal: boolean,
): Promise<Page<SessionRow>> {
  const result = await call(b, "listSessions", {
    after_name: afterName,
    limit,
    include_total: includeTotal,
  });
  return toPage<SessionRow>(result, "next_after_name");
}
