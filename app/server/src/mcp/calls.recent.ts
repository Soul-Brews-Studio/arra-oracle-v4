import { openCallLogTable } from "./calls.openCallLogTable";
import { quote } from "./calls.quote";
import { requiredBank } from "./calls.requiredBank";
import { safeInteger } from "./calls.safeInteger";

const wireInteger = (value: bigint | number) =>
  typeof value === "bigint"
    ? safeInteger(value)
    : Number.isSafeInteger(value) ? value : String(value);

const wireTime = (value: bigint | number) => {
  const exact = wireInteger(value);
  if (typeof exact === "string") return exact;
  const date = new Date(exact);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(exact);
};

export async function recent(bank: string, limit = 20, status?: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await openCallLogTable();
  await tbl.checkoutLatest(); // a Table handle pins a version — see db.ts
  const predicates = [`workspace_name = ${quote(scopedBank)}`];
  if (status) predicates.push(`status = ${quote(status)}`);
  const rows = await tbl
    .query()
    .where(predicates.join(" AND "))
    .orderBy([
      { columnName: "created_at", ascending: false },
      { columnName: "id", ascending: false },
    ])
    .limit(Math.max(0, limit))
    .toArray();
  return rows.map((r: any) => ({
    id: r.id,
    workspace_name: r.workspace_name,
    tool: r.tool,
    status: r.status,
    duration_ms: wireInteger(r.duration_ms),
    at: wireTime(r.created_at),
    ...JSON.parse(r.h_metadata ?? "{}"),
  }));
}
