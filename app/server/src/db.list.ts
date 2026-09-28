import { db } from "./db.db";
import { clean } from "./db.clean";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";
import { memoriesBackend } from "./db.legacyRead.backend";
import { legacyReadList } from "./db.legacyRead.list";

export interface MemoryFilters {
  type?: string;
  session_name?: string;
  peer_name?: string;
  subject_peer_name?: string;
  sync_state?: string;
  is_active?: boolean;
}

export async function list(bank: string, limit = 50, filters: MemoryFilters = {}) {
  if (memoriesBackend() === "target19") return legacyReadList(bank, limit, filters);
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  let q = tbl.query();
  // Scope is unconditional; filters remain optional and are still applied
  // BEFORE the limit, so a limit never selects from an unfiltered set.
  const predicates: string[] = [`workspace_name = ${quote(scopedBank)}`];
  for (const key of ["type", "session_name", "peer_name", "subject_peer_name", "sync_state"] as const) {
    const value = filters[key];
    if (value !== undefined) predicates.push(`${key} = ${quote(value)}`);
  }
  if (filters.is_active !== undefined) predicates.push(`is_active = ${filters.is_active}`);
  q = q.where(predicates.join(" AND "));
  q = q.limit(limit);
  return clean(await q.toArray());
}
