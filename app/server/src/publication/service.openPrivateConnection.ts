import { type Connection, assertTargetDataset } from "./storage";
import { connect } from "@lancedb/lancedb";

/**
 * Open and validate a connection, privately.
 *
 * Lives here rather than in `storage.ts` so no module exports a function
 * returning a raw `Connection`. readConsistencyInterval 0 makes every read
 * re-check for a newer version instead of serving what this process last saw.
 */
export async function openPrivateConnection(canonicalRoot: string): Promise<Connection> {
  const connection = await connect(canonicalRoot, { readConsistencyInterval: 0 });
  await assertTargetDataset(connection);
  return connection;
}
