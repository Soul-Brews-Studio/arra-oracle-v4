import { db } from "./db.db";
import { clean } from "./db.clean";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";
import { substringSearch, type FtsResult } from "./fts/fts";
import { backend } from "./db.legacyRead.backend";
import { searchText as legacyReadSearchText } from "./db.legacyRead.searchText";

// Keyword search is a substring contract: every row returned contains `q`
// (case-folded), and `match` says whether the trigram index or, for a query
// under 3 code points, the bounded substring scan produced it.
export async function searchText(q: string, bank: string, limit = 10): Promise<FtsResult<ReturnType<typeof clean>[number]>> {
  if (backend() === "target19") return legacyReadSearchText(q, bank, limit);
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const { match, rows } = await substringSearch(tbl, "content", q, `workspace_name = ${quote(scopedBank)}`, limit);
  return { match, rows: clean(rows) };
}
