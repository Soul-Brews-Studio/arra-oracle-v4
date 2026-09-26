// Owned fault-test child for bounded storage-layer failures around the head step.
//
// Unlike `corrupt-after-append.ts`, nothing here mutates a row to provoke a
// readback disagreement. This child makes the `nodes` TABLE ITSELF fail at the
// storage layer, so the service meets a genuine SDK rejection rather than a
// contrived hook error. Every boundary hook RETURNS NORMALLY; a throwing hook
// would exercise the hook-error branch instead of the branch under test.
//
// Two different permission states, because they land on DIFFERENT steps:
//   unreadable (0o500 -> 0o000 equivalent, no traversal): the very next READ
//     of the table fails. On the fresh path that is the post-append node
//     re-check, which runs after revision durability and carries no wrapper
//     of its own.
//   unwritable (0o500 on the table dir AND its subdirectories): reads still
//     succeed, so the service gets past its re-check and fails on the actual
//     `append("nodes", ...)`. Lance writes new files into `data/` and
//     `_versions/`, so denying only the top directory would not stop a write.
//
// Scenarios:
//   "fresh_read"  - fault at after_revision_readback, table unreadable.
//                   Rejection lands on the post-durability node re-check.
//   "fresh_write" - fault at after_revision_readback, table unwritable.
//                   Rejection lands on the real node append.
//   "orphan"      - seed a revision, strand it by deleting its node row, then
//                   resume it with the table unwritable so the rejection lands
//                   on the orphan-resume head append.
//   "control"     - no fault; the first request is invalid BEFORE any write,
//                   proving a pre-write rejection leaves the owner usable.
//
// The gate is acquired ONCE and never released mid-run. Closing the service
// would drop the inherited descriptor (fd 42) and no later open could
// reacquire it, so the orphan is prepared through this process's own
// connection while the gate is still held -- the same standing this child
// already has to write here at all.
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readArgPayload } from "../../helpers/argv.readArgPayload";

const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  scenario: "fresh_read" | "fresh_write" | "orphan" | "control";
  first: unknown;
  second: unknown;
  revisionIds: string[];
  clockMs: number;
  /** Node whose row the orphan scenario deletes to strand its revision. */
  orphanNodeId?: string;
};

const { connect } = await import("@lancedb/lancedb");
const { openPublicationWriter } = await import(
  new URL("../../../src/publication/service.ts", import.meta.url).pathname
);

const NODES_TABLE = join(datasetRoot!, "nodes.lance");

/** Apply a mode to the table directory and every directory beneath it. */
const chmodTree = (dir: string, mode: number): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodTree(join(dir, entry.name), mode);
  }
  chmodSync(dir, mode);
};
/** No traversal at all: the next read of the table fails. */
const makeUnreadable = () => chmodSync(NODES_TABLE, 0o000);
/** Readable but no new entries anywhere: reads pass, the append fails. */
const makeUnwritable = () => chmodTree(NODES_TABLE, 0o500);
/** Restore, so what a later operation meets is the POISONED OWNER and not a
 *  filesystem that is still broken underneath it. */
const repair = () => {
  chmodSync(NODES_TABLE, 0o755);
  chmodTree(NODES_TABLE, 0o755);
};

const results: Record<string, unknown> = {};
let index = 0;
let faulted = false;

const countRows = async (table: string): Promise<number> => {
  const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const rows = await (await conn.openTable(table))
    .query()
    .where("workspace_name = 'alpha-workspace'")
    .toArray();
  return rows.length;
};

const installFresh = async (boundary: string) => {
  if (boundary !== "after_revision_readback" || faulted) return;
  faulted = true;
  if (payload.scenario === "fresh_read") makeUnreadable();
  else makeUnwritable();
  // Returns normally: the service walks into its own next step and meets the
  // storage rejection there, which is the case under test.
};

const service = await openPublicationWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[index++] ?? "zzzzzzzzzzzzzzzzzzzzz",
  clock: () => payload.clockMs,
  ...(payload.scenario === "fresh_read" || payload.scenario === "fresh_write"
    ? { onBoundary: installFresh }
    : {}),
});

const attempt = async (label: string, request: unknown) => {
  try {
    results[label] = {
      ok: true,
      outcome: await service.publishRevision(new TextEncoder().encode(JSON.stringify(request))),
    };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    results[label] = { ok: false, code: e.code ?? null, message: (e.message ?? "").slice(0, 200) };
  }
};

if (payload.scenario === "orphan") {
  // 1. Publish normally so a revision exists durably. Gate stays held.
  await attempt("seed", payload.first);
  // 2. Strand it: remove the node row, leaving a revision with no head. The
  //    connection below is this process's own, and this process holds the
  //    gate, so it is the one party entitled to write here.
  const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
  await (await conn.openTable("nodes")).delete(`id = '${payload.orphanNodeId ?? ""}'`);
  results.beforeResume = { revisionRows: await countRows("node_revisions"), nodeRows: await countRows("nodes") };
  // 3. Deny writes only. Resume re-reads nodes and node_revisions before it
  //    heads anything, so those must keep working or this would prove nothing
  //    about the head write.
  makeUnwritable();
  // 4. Same operation id: the service finds the durable orphan and resumes it,
  //    and the head append is the first thing that resume writes.
  await attempt("first", payload.first);
  repair();
} else {
  await attempt("first", payload.first);
  if (payload.scenario !== "control") repair();
}

// The SECOND operation always runs against a repaired filesystem, so a refusal
// here can only come from the owner's own fail-stop state.
await attempt("second", payload.second);

try {
  await service.close();
} catch {
  // A poisoned owner may refuse close paths; that is not what this measures.
}

results.revisionRows = await countRows("node_revisions");
results.nodeRows = await countRows("nodes");

console.log(JSON.stringify(results));
