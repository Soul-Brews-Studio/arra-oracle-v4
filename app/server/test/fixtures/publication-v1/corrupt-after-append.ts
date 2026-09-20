// Owned fault-test child for the post-write poisoning gate.
//
// Parks at `after_revision_append`, CORRUPTS the row that was just written,
// and then RETURNS NORMALLY. The hook does not throw, so the failure the
// service meets is a genuine readback failure rather than a hook error --
// which is exactly the case the existing D1 tests do not cover.
//
// It corrupts through its own connection, legitimately: this process is the
// gate holder, so it is the one party allowed to write here.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  first: unknown;
  second: unknown;
  revisionIds: string[];
  clockMs: number;
  corruptRevisionId: string;
  claimNodeId?: string;
  /** "digest" corrupts the revision row; "head" breaks the node head write. */
  mode?: "digest" | "head";
};

const { connect } = await import("@lancedb/lancedb");
const { openPublicationWriter } = await import(
  new URL("../../../src/publication/service.ts", import.meta.url).pathname
);

let index = 0;
let corrupted = false;

const service = await openPublicationWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds[index++] ?? "zzzzzzzzzzzzzzzzzzzzz",
  clock: () => payload.clockMs,
  onBoundary: async (boundary: string) => {
    if (boundary !== "after_revision_append" || corrupted) return;
    corrupted = true;
    if (payload.mode === "head") {
      // Move the node head AFTER the service captured it but BEFORE its
      // guarded conditional update runs. The update then matches zero rows,
      // which is a genuine ambiguous outcome at the head-write site -- the
      // revision row is already durable. The hook still returns normally.
      const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
      const nodes = await conn.openTable("nodes");
      await nodes.update(
        { current_revision_id: `'${"y".repeat(21)}'` },
        { where: `id = '${payload.claimNodeId ?? ""}'` },
      );
      return;
    }
    // Rewrite content_digest so the recomputed digest will not match. The
    // row is durably appended at this point, so the service is now in the
    // ambiguous post-write state the contract cares about.
    const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
    const tbl = await conn.openTable("node_revisions");
    await tbl.update(
      { content_digest: `'${"b".repeat(64)}'` },
      { where: `id = '${payload.corruptRevisionId}'` },
    );
  },
});

const results: Record<string, unknown> = {};
const attempt = async (label: string, request: unknown) => {
  try {
    results[label] = { ok: true, outcome: await service.publishRevision(
      new TextEncoder().encode(JSON.stringify(request)),
    ) };
  } catch (error) {
    const e = error as { code?: string };
    results[label] = { ok: false, code: e.code ?? null };
  }
};

await attempt("first", payload.first);
// A SECOND operation on the same owner: if the first left the owner
// ambiguous, this must be refused rather than writing again.
await attempt("second", payload.second);

// How many rows actually exist, counted independently of the service.
const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
const rows = await (await conn.openTable("node_revisions")).query().where("workspace_name = 'alpha-workspace'").toArray();
results.revisionRows = rows.length;

console.log(JSON.stringify(results));
try {
  await service.close();
} catch {
  // A poisoned owner may refuse close paths; that is not what this measures.
}
