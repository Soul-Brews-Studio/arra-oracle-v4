import { db } from "./db.db";
import { clean } from "./db.clean";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";

export async function getById(bank: string, id: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const rows = await tbl
    .query()
    .where(`workspace_name = ${quote(scopedBank)} AND id = ${quote(id)}`)
    .limit(1)
    .toArray();
  return clean(rows)[0] ?? null;
}
