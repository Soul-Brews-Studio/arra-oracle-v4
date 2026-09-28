import { db } from "./db.db";
import { ensureFtsIndexOn } from "./fts/fts";

// The content index is the shared character trigram (R14, `fts/fts.constants.ts`),
// not `icu`: icu segments whole Thai words and cannot find ลืม inside หลงลืม (#10).
// `replace: false` keeps an index whose live details already match and rebuilds
// one that does not (an older deployment's icu) once, under the same name.
export async function ensureFtsIndex(replace = true): Promise<string[]> {
  return ensureFtsIndexOn(await db(), "content", replace);
}
