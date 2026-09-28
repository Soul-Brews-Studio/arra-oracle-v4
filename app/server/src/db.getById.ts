import { db } from "./db.db";
import { clean } from "./db.clean";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";
import { memoriesBackend } from "./db.legacyRead.backend";
import { legacyReadGetById } from "./db.legacyRead.getById";

// R33 S2: dark-launched target-19 read path, `ARRA_MEMORIES_BACKEND=target19`,
// default off (see docs/overnight/LEGACY-ROOT-RETIREMENT-PLAN.md). Flag off
// leaves every line below this check byte-for-byte the legacy path.
export async function getById(bank: string, id: string) {
  if (memoriesBackend() === "target19") return legacyReadGetById(bank, id);
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const rows = await tbl
    .query()
    .where(`workspace_name = ${quote(scopedBank)} AND id = ${quote(id)}`)
    .limit(1)
    .toArray();
  return clean(rows)[0] ?? null;
}
