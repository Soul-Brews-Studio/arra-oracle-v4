import { db } from "./db.db";
import { quote } from "./db.quote";
import { requiredBank } from "./db.requiredBank";
import { TABLE } from "./db.state";
import { DIMS } from "./embed";
import { storageInfo } from "./storage";

export async function stats(bank: string) {
  const scopedBank = requiredBank(bank);
  const tbl = await db();
  const scope = `workspace_name = ${quote(scopedBank)}`;
  const rows = await tbl.countRows(scope);
  const unembedded = await tbl.countRows(`${scope} AND embedding IS NULL`);
  return {
    table: TABLE,
    storage: storageInfo(),
    rows,
    embedded: rows - unembedded,
    unembedded,
    version: await tbl.version(),
    dims: DIMS,
    indices: (await tbl.listIndices()).map((i) => `${i.name}:${i.indexType}`),
  };
}
