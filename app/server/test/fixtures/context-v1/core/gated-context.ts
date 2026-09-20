// Owned test child for the #59 context kernel.
//
// Runs INSIDE the writer gate (exec'd by the Python launcher), drives the
// context facade through a list of operations, and prints one JSON line.
//
// Records the boundary trace in firing order AND the persisted scoped
// identities separately: counts alone cannot prove WHICH row was written.
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<{ method: string; request: unknown }>;
  clockMs: number;
  sourceNamespace?: string | null;
  failAt?: { boundary: string; occurrence: number };
  readAfterRelease?: boolean;
  contendSameRoot?: boolean;
  freshReader?: boolean;
};

const { connect } = await import("@lancedb/lancedb");
const { openContextReader, openContextWriter } = await import(
  new URL("../../../../src/publication/service.ts", import.meta.url).pathname
);

const trace: string[] = [];
const counts = new Map<string, number>();
const results: Record<string, unknown> = {};

/** Full envelope. A code alone cannot reveal a wrong version. */
const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string } };
  let version: string | null = null;
  try {
    version = typeof e.toJSON === "function" ? (e.toJSON().version ?? null) : null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version };
};

const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => "unusedunusedunused000",
  clock: () => payload.clockMs,
  sourceNamespace: payload.sourceNamespace ?? null,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
    const seen = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, seen);
    if (payload.failAt && payload.failAt.boundary === boundary && payload.failAt.occurrence === seen) {
      throw new Error("commanded hook failure");
    }
  },
});

for (const [index, op] of payload.ops.entries()) {
  const call = (service.context as Record<string, (b: Uint8Array) => Promise<unknown>>)[op.method];
  const label = `op${index}`;
  if (typeof call !== "function") {
    results[label] = { ok: false, code: "no_such_method" };
    continue;
  }
  try {
    results[label] = { ok: true, value: await call(new TextEncoder().encode(JSON.stringify(op.request))) };
  } catch (error) {
    results[label] = { ok: false, ...describeError(error) };
  }
}

if (payload.contendSameRoot) {
  try {
    const rival = await openContextWriter(datasetRoot!, {
      newRevisionId: () => "unusedunusedunused001",
      clock: () => payload.clockMs,
      sourceNamespace: null,
    });
    results.contention = { ok: true };
    await rival.close();
  } catch (error) {
    results.contention = { ok: false, ...describeError(error) };
  }
}

// Shapes, asserted from the actual objects rather than from the source text.
results.writerKeys = Object.keys(service).sort();
results.contextMethods = Object.keys(service.context).sort();
results.publicationKeys = Object.keys(service.publication).sort();
results.taxonomyHasClose = "close" in service.taxonomy;
results.contextHasClose = "close" in service.context;

try {
  await service.close();
} catch {
  // A poisoned owner may refuse close paths; that is not what this measures.
}

if (payload.readAfterRelease) {
  try {
    await service.context.getPeer(
      new TextEncoder().encode(JSON.stringify({ workspace_name: "alpha-workspace", peer_name: "peer-a" })),
    );
    results.readAfterRelease = { ok: true };
  } catch (error) {
    results.readAfterRelease = { ok: false, ...describeError(error) };
  }
}

// A gateless READER after the writer released. Reads need no gate, so this
// must work where a released writer's own reads do not.
if (payload.freshReader) {
  try {
    const reader = await openContextReader(datasetRoot!);
    results.readerKeys = Object.keys(reader).sort();
    results.readerContextMethods = Object.keys(reader.context).sort();
    results.freshReaderPeer = await reader.context.getPeer(
      new TextEncoder().encode(JSON.stringify({ workspace_name: "alpha-workspace", peer_name: "peer-a" })),
    );
  } catch (error) {
    results.freshReader = { ok: false, ...describeError(error) };
  }
}

const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
const namesOf = async (table: string, column = "name") => {
  const rows = await (await conn.openTable(table)).query().toArray();
  return rows.map((r: Record<string, unknown>) => String(r[column]));
};
results.persistedPeers = await namesOf("peers");
results.persistedSessions = await namesOf("sessions");
results.persistedMemberships = await namesOf("session_peers", "peer_name");
results.persistedMessages = await namesOf("messages", "public_id");
results.trace = trace;

console.log(JSON.stringify(results));
