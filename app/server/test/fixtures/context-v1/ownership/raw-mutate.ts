// #60 ownership setup — reach states this slice deliberately never creates.
//
// SETUP, never an oracle. The context interface has no operation that sets
// `left_at` or deactivates a session, yet §3 and §8 rule on both, so the state
// has to be produced some other way. This does it with a raw gated connection
// in a disposable copy, and asserts nothing.
//
// It takes the writer gate exactly like every other writer, holds it once for
// the process, and exports no product authority: the SDK is used directly here
// rather than through any service factory.

import { connect } from "@lancedb/lancedb";

const [, , mode, root, workspace, name, peerName] = process.argv;

const db = await connect(root!, { readConsistencyInterval: 0 });
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

if (mode === "leave-membership") {
  const table = await db.openTable("session_peers");
  await table.update(
    { left_at: "CAST('2026-09-21T00:00:00' AS TIMESTAMP)" },
    {
      where: `workspace_name = ${quote(workspace!)} AND session_name = ${quote(name!)} AND peer_name = ${quote(peerName!)}`,
    },
  );
  const rows = await table
    .query()
    .where(`workspace_name = ${quote(workspace!)} AND session_name = ${quote(name!)}`)
    .toArray();
  console.log(`EVENT raw:left rows=${rows.length}`);
}

if (mode === "deactivate-session") {
  const table = await db.openTable("sessions");
  await table.update({ is_active: "false" }, { where: `workspace_name = ${quote(workspace!)} AND name = ${quote(name!)}` });
  const rows = await table
    .query()
    .where(`workspace_name = ${quote(workspace!)} AND name = ${quote(name!)}`)
    .toArray();
  console.log(`EVENT raw:deactivated rows=${rows.length}`);
}

// #87: a stored message that fails its own integrity check (`token_count`
// below zero), so a read boundary can be tested against corrupt storage.
if (mode === "corrupt-message") {
  const table = await db.openTable("messages");
  await table.update({ token_count: "-1" }, { where: `workspace_name = ${quote(workspace!)} AND public_id = ${quote(name!)}` });
  const rows = await table
    .query()
    .where(`workspace_name = ${quote(workspace!)} AND public_id = ${quote(name!)} AND token_count < 0`)
    .toArray();
  console.log(`EVENT raw:corrupted rows=${rows.length}`);
}

console.log("EVENT done");
