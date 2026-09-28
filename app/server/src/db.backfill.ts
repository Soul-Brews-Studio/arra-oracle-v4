import { db } from "./db.db";
import { embed } from "./embed";

/** After this many failures a row stops being retried and stays `failed`. */
const MAX_SYNC_ATTEMPTS = 5;

// The backfill: find rows with no vector, embed them, write vectors back by id.
export async function backfill(batch = 32) {
  const tbl = await db();
  // MAX_ATTEMPTS bounds the poison-row loop §4.6.1 warns about.
  const pending = await tbl
    .query()
    .where(`embedding IS NULL AND sync_attempts < ${MAX_SYNC_ATTEMPTS}`)
    .limit(batch)
    .toArray();
  if (pending.length === 0) return { embedded: 0, remaining: 0 };

  // An embedder outage must COUNT against each row, not silently retry forever.
  // §4.6.1: sync_attempts is what lets a backfill give up on a poison row.
  let vectors: number[][];
  try {
    vectors = await embed(pending.map((r: any) => r.content));
  } catch (e) {
    await tbl.mergeInsert("id").whenMatchedUpdateAll().execute(
      pending.map((r: any) => ({
        ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "embedding")),
        embedding: null,
        sync_state: "failed",
        sync_attempts: typeof r.sync_attempts === "bigint"
          ? r.sync_attempts + 1n
          : Number(r.sync_attempts ?? 0) + 1,
      })),
    );
    throw e;
  }
  await tbl
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .execute(
      pending.map((r: any, i: number) => ({
        ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== "embedding")),
        embedding: vectors[i],
        sync_state: "synced",
        last_sync_at: new Date(),
      })),
    );

  const remaining = (await tbl.query().where("embedding IS NULL").toArray()).length;
  return { embedded: pending.length, remaining };
}
