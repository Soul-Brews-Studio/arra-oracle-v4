// Owned test child for the #34 projection-rebuild lane.
//
// Runs INSIDE the writer gate (exec'd by the Python launcher, `runGated`) on
// a COPY of a migrated candidate whose derived tables were emptied. For every
// stored revision it calls the kernel's own `reconcileRevisionAssociations`,
// which re-derives node_revision_terms and revision_links from the revision's
// authoritative snapshots, and prints one JSON line: revision id -> outcome.
// It publishes nothing: a revision-id request is a fault here.
const [, , datasetRoot] = Bun.argv;
if (!datasetRoot) {
  console.error("usage: reconcile-child.ts <dataset-root>");
  process.exit(2);
}

const { connect } = await import("@lancedb/lancedb");
const { openEvidenceWriter } = await import(
  new URL("../../../src/publication/service.openEvidenceWriter.ts", import.meta.url).pathname
);

const connection = await connect(datasetRoot, { readConsistencyInterval: 0 });
const revisions = (await (await connection.openTable("node_revisions")).query().toArray()) as Array<
  Record<string, unknown>
>;
connection.close();

const bundle = await openEvidenceWriter(datasetRoot, {
  clock: () => Date.parse("2026-09-26T14:00:00.000Z"),
  newRevisionId: () => {
    throw new Error("the rebuild lane never publishes");
  },
  sourceNamespace: null,
  env: process.env,
});
const outcomes: Record<string, unknown> = {};
try {
  for (const revision of revisions) {
    const request = { workspace_name: revision.workspace_name, node_id: revision.node_id, revision_id: revision.id };
    const result = (await bundle.evidence.reconcileRevisionAssociations(
      new TextEncoder().encode(JSON.stringify(request)),
    )) as { outcome: string; terms: unknown; links: unknown };
    outcomes[String(revision.id)] = { outcome: result.outcome, terms: result.terms, links: result.links };
  }
} finally {
  await bundle.close();
}
console.log(JSON.stringify({ outcomes }));
