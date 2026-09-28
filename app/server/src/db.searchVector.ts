import { db } from "./db.db";
import { clean } from "./db.clean";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";
import { embedOne } from "./embed";
import { backend } from "./db.legacyRead.backend";
import { searchVector as legacyReadSearchVector } from "./db.legacyRead.searchVector";

export async function searchVector(q: string, bank: string, limit = 10) {
  if (backend() === "target19") return legacyReadSearchVector(q, bank, limit);
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
