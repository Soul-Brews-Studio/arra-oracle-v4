import { type ApiResult } from "./client";
import { type SessionLinkRow } from "./evidenceReview";

export function sessionLinksOf(result: ApiResult): { rows: SessionLinkRow[]; nextCursor: string | null } {
  if (!result.ok) return { rows: [], nextCursor: null };
  const body = result.body as { rows?: SessionLinkRow[]; next_cursor?: string | null } | null;
  return {
    rows: Array.isArray(body?.rows) ? (body!.rows as SessionLinkRow[]) : [],
    nextCursor: typeof body?.next_cursor === "string" ? body.next_cursor : null,
  };
}
