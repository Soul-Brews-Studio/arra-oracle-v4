import { db } from "./db.db";
import { clean } from "./db.clean";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";
import { embedOne } from "./embed";

export async function searchVector(q: string, bank: string, limit = 10) {
  // Scope first: a rejected request must cost no embedder call and no table open.
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const vec = await embedOne(q);
  const rows = await tbl
    .vectorSearch(vec)
    .where(`workspace_name = ${quote(scopedBank)}`)
    .limit(limit)
    .toArray();
  return clean(rows);
}
