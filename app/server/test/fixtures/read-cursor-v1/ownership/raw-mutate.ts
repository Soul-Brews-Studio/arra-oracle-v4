// #72 ownership setup — reach states this slice deliberately never creates.
//
// SETUP, never an oracle. The cursor interface has no operation that sets
// `left_at` or deactivates a session, yet §3 rules on both: neither may block
// reading or recording progress. The state therefore has to be produced another
// way, and this does it with a raw gated connection on a disposable copy.
//
// It takes the writer gate exactly like every other writer, holds it once for
// the process, and exports no product authority: the SDK is used directly here
// rather than through any service factory. It asserts nothing.

import { connect } from "@lancedb/lancedb";

const [, , mode, root, workspace, name, peerName] = process.argv;

const db = await connect(root!, { readConsistencyInterval: 0 });
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Report the ACTUAL staged state, scoped, so the parent can assert the premise
 *  rather than trusting a row count or an exit code. */
const report = (event: string, rows: Record<string, unknown>[], fields: string[]) =>
  console.log(
    `EVENT ${event} ${JSON.stringify(
      rows.map((row) => Object.fromEntries(fields.map((f) => [f, row[f] === null || row[f] === undefined ? null : String(row[f])]))),
    )}`,
  );

if (mode === "leave-membership") {
  const table = await db.openTable("session_peers");
  const scope = `workspace_name = ${quote(workspace!)} AND session_name = ${quote(name!)} AND peer_name = ${quote(peerName!)}`;
  await table.update({ left_at: "CAST('2026-09-21T00:00:00' AS TIMESTAMP)" }, { where: scope });
  report("raw:left", await table.query().where(scope).toArray(), [
    "workspace_name",
    "session_name",
    "peer_name",
    "left_at",
  ]);
}

if (mode === "deactivate-session") {
  const table = await db.openTable("sessions");
  const scope = `workspace_name = ${quote(workspace!)} AND name = ${quote(name!)}`;
  await table.update({ is_active: "false" }, { where: scope });
  report("raw:deactivated", await table.query().where(scope).toArray(), ["workspace_name", "name", "is_active"]);
}

console.log("EVENT done");
