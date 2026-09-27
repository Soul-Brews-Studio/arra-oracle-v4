import { foldQueues, foldState } from "./connections.state";

/**
 * Test seam: clears the latch, the failure count and any pending per-id fold
 * queue. The cached connection is no longer cleared here: it moved to
 * `connections.openConnectionsTable.ts`, whose header records the
 * measurement showing it holds no state a reset would need to drop.
 *
 * It does NOT re-point the store. `DATA_DIR` is captured from the environment
 * at module load (`storage.ts`), so setting `ARRA_DATA_DIR` after import has
 * no effect -- a test that needs a different store must run in its own
 * process with the variable already set. Learned by writing a probe that
 * reset the state, changed the env var, and kept writing to the old path.
 */
export function resetConnectionFoldState(): void {
  foldState.tableAbsent = false;
  foldState.foldFailures = 0;
  foldQueues.clear();
}
