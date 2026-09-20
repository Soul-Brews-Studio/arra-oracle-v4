// Owned test child for the #47 taxonomy kernel.
//
// Runs INSIDE the writer gate (exec'd by the Python launcher), drives the
// knowledge writer through a list of operations, and prints one JSON line.
//
// It records the boundary trace in firing order AND, separately, the scoped
// identities actually persisted. Counts alone cannot prove WHICH row was
// written, so a crash-prefix assertion needs both.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ method: string; request: unknown }>;
  clockMs: number;
  /** Throw from the hook the Nth time this boundary fires (1-based). */
  failAt?: { boundary: string; occurrence: number; forge?: boolean };
  /** Stop the process hard at that point instead, simulating a crash. */
  crashAt?: { boundary: string; occurrence: number };
  /** Workspace to read from while the owner is poisoned / after release. */
  readWhilePoisoned?: string;
  readAfterRelease?: string;
  /** Open a SECOND writer on the same root while this one holds it. */
  contendSameRoot?: boolean;
  /** Make a table unwritable at the Nth firing of a boundary (1-based). */
  breakTableAt?: { boundary: string; occurrence: number; table: string };
  /** Rows written directly as fixture state BEFORE any op runs. */
  plant?: { table: string; rows: Record<string, unknown>[] };
  /** Corrupt a stored field at the Nth firing of a boundary, then RETURN
   *  normally. Not a thrown hook: the service meets bad durable state. */
  corruptAt?: {
    boundary: string;
    occurrence: number;
    table: string;
    id: string;
    field: string;
    value: string;
  };
};

import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { connect } = await import("@lancedb/lancedb");

/**
 * Deny writes to a table at the STORAGE layer, leaving reads working.
 *
 * Lance writes new files into `data/` and `_versions/`, so denying only the
 * top directory would not stop a write. This is a real SDK rejection, not a
 * thrown hook: the contract requires both to be tested separately.
 */
const chmodTree = (dir: string, mode: number): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) chmodTree(join(dir, entry.name), mode);
  }
  chmodSync(dir, mode);
};
const { openKnowledgeWriter } = await import(
  new URL("../../../../src/publication/service.ts", import.meta.url).pathname
);

const trace: string[] = [];
const counts = new Map<string, number>();

const results: Record<string, unknown> = {};

/** Record the full envelope. A code alone cannot reveal a wrong version. */
const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as {
    name?: string;
    code?: string;
    path?: string;
    toJSON?: () => { version?: string };
  };
  let version: string | null = null;
  try {
    version = typeof e.toJSON === "function" ? (e.toJSON().version ?? null) : null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version };
};

const service = await openKnowledgeWriter(datasetRoot!, {
  newRevisionId: () => "unusedunusedunused000",
  clock: () => payload.clockMs,
  onTaxonomyBoundary: async (boundary: string) => {
    trace.push(boundary);
    const seen = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, seen);
    if (payload.crashAt && payload.crashAt.boundary === boundary && payload.crashAt.occurrence === seen) {
      // Persisted state is inspected by the PARENT afterwards; this process
      // simply stops existing, which is what a real crash looks like.
      console.log(JSON.stringify({ ...results, trace, crashed: boundary }));
      process.exit(9);
    }
    if (payload.failAt && payload.failAt.boundary === boundary && payload.failAt.occurrence === seen) {
      if (payload.failAt.forge) {
        // Shaped like a governed contract error, but not one. If the boundary
        // trusts a `name` property it will pass this through and leak
        // whatever text it carries.
        const forged = new Error("FORGED-PRIVATE-TEXT");
        forged.name = "ContractError";
        throw forged;
      }
      throw new Error("commanded hook failure");
    }
    if (
      payload.corruptAt &&
      payload.corruptAt.boundary === boundary &&
      payload.corruptAt.occurrence === seen
    ) {
      const c = payload.corruptAt;
      const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
      await (await conn.openTable(c.table)).update(
        { [c.field]: c.value },
        { where: `id = '${c.id}'` },
      );
      // Returns normally. The row is durable and WRONG.
    }
    if (
      payload.breakTableAt &&
      payload.breakTableAt.boundary === boundary &&
      payload.breakTableAt.occurrence === seen
    ) {
      // Returns NORMALLY. The service walks into its own next SDK write and
      // meets a genuine storage rejection there.
      chmodTree(join(datasetRoot!, `${payload.breakTableAt.table}.lance`), 0o500);
    }
  },
});

const run = async (index: number, op: { method: string; request: unknown }) => {
  const call = (service.taxonomy as Record<string, (b: Uint8Array) => Promise<unknown>>)[op.method];
  const label = `op${index}`;
  if (typeof call !== "function") {
    results[label] = { ok: false, code: "no_such_method" };
    return;
  }
  try {
    const value = await call(new TextEncoder().encode(JSON.stringify(op.request)));
    results[label] = { ok: true, value };
  } catch (error) {
    results[label] = { ok: false, ...describeError(error) };
  }
};

if (payload.plant) {
  // Pre-existing state this child writes through its own gated connection.
  // It holds the gate, so it is the one party entitled to write here.
  const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const rows = payload.plant.rows.map((row) => ({
    ...row,
    created_at: new Date(payload.clockMs),
  }));
  await (await conn.openTable(payload.plant.table)).add(rows);
  results.planted = rows.length;
}

for (const [index, op] of payload.ops.entries()) {
  await run(index, op);
  if (payload.breakTableAt && index === 0) {
    // Repair BEFORE the next operation, so a later refusal can only be the
    // owner's own fail-stop state and not a filesystem still broken.
    const dir = join(datasetRoot!, `${payload.breakTableAt.table}.lance`);
    chmodSync(dir, 0o755);
    chmodTree(dir, 0o755);
    results.repaired = true;
  }
}

// A read on the SAME owner while it is poisoned. Reads are off the write
// queue, so a poisoned owner must still answer them.
if (payload.readWhilePoisoned) {
  try {
    const value = await service.taxonomy.getVocabulary(
      new TextEncoder().encode(
        JSON.stringify({ workspace_name: payload.readWhilePoisoned, vocabulary_id: "typevoc00000000000000" }),
      ),
    );
    results.readWhilePoisoned = { ok: true, absent: value === null };
  } catch (error) {
    const e = error as { name?: string; code?: string };
    results.readWhilePoisoned = { ok: false, name: e.name ?? null, code: e.code ?? null };
  }
}

// A SECOND writer on the same canonical root, while this one still holds it.
if (payload.contendSameRoot) {
  try {
    const rival = await openKnowledgeWriter(datasetRoot!, {
      newRevisionId: () => "unusedunusedunused001",
      clock: () => payload.clockMs,
    });
    results.contention = { ok: true };
    await rival.close();
  } catch (error) {
    const e = error as { name?: string; code?: string };
    results.contention = { ok: false, name: e.name ?? null, code: e.code ?? null };
  }
}

try {
  await service.close();
} catch {
  // A poisoned owner may refuse close paths; that is not what this measures.
}

// The SAME read after release. The adapter is gone, so this must be refused
// rather than quietly answering from a stale handle.
if (payload.readAfterRelease) {
  const ws = payload.readAfterRelease;
  const probe = async (label: string, run: () => Promise<unknown>) => {
    try {
      await run();
      results[label] = { ok: true };
    } catch (error) {
      results[label] = { ok: false, ...describeError(error) };
    }
  };
  await probe("readAfterRelease", () =>
    service.taxonomy.getVocabulary(
      new TextEncoder().encode(
        JSON.stringify({ workspace_name: ws, vocabulary_id: "typevoc00000000000000" }),
      ),
    ),
  );
  await probe("readTermAfterRelease", () =>
    service.taxonomy.getTerm(
      new TextEncoder().encode(
        JSON.stringify({ workspace_name: ws, term_id: "tnote0000000000000000" }),
      ),
    ),
  );
  // Control: the PUBLICATION facade must keep its own envelope unchanged.
  await probe("publicationReadAfterRelease", () =>
    service.publication.getAcceptedHead(
      new TextEncoder().encode(
        JSON.stringify({ workspace_name: ws, node_id: "a".repeat(21) }),
      ),
    ),
  );
}

// Persisted scoped identities, read independently of the service.
const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
const idsOf = async (table: string) => {
  const rows = await (await conn.openTable(table)).query().toArray();
  return rows.map((r: Record<string, unknown>) => String(r.name));
};
results.persistedTerms = await idsOf("terms");
results.persistedVocabularies = await idsOf("vocabularies");
results.trace = trace;

console.log(JSON.stringify(results));
