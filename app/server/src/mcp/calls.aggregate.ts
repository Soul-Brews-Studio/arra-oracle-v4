import { openCallLogTable } from "./calls.openCallLogTable";
import { quote } from "./calls.quote";
import { requiredBank } from "./calls.requiredBank";

export async function aggregate(bank: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await openCallLogTable();
  await tbl.checkoutLatest();
  const rows = await tbl.query().where(`workspace_name = ${quote(scopedBank)}`).toArray();
  const byTool: Record<string, { calls: number; errors: number; total_ms: number }> = {};
  for (const r of rows as any[]) {
    const t = (byTool[r.tool] ??= { calls: 0, errors: 0, total_ms: 0 });
    t.calls++;
    if (r.status === "error") t.errors++;
    t.total_ms += Number(r.duration_ms ?? 0);
  }
  return {
    total: rows.length,
    tools: Object.fromEntries(
      Object.entries(byTool).map(([k, v]) => [
        k,
        { ...v, avg_ms: v.calls ? Math.round(v.total_ms / v.calls) : 0, total_ms: undefined },
      ]),
    ),
  };
}
