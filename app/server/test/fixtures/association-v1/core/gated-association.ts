// Owned test child for the #65 association kernel. Runs INSIDE the real gate.
//
// Records the boundary trace in firing order AND the persisted derived-row
// identities separately: counts alone cannot prove WHICH row was written.
import { readArgPayload } from "../../../helpers/argv.readArgPayload";
const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  ops: Array<{
    facade?: "evidence" | "publication" | "taxonomy" | "harness";
    method: string;
    request: any;
  }>;
  clockMs: number;
  revisionIds?: string[];
  failAt?: { boundary: string; occurrence: number };
  /** The ACCEPTED publisher's own operator fault seam, not a new hook. */
  failPublicationAt?: { boundary: string; occurrence: number };
};

const { connect } = await import("@lancedb/lancedb");
const { openEvidenceWriter } = await import(
  new URL("../../../../src/publication/service.ts", import.meta.url).pathname
);

const trace: string[] = [];
const publicationTrace: string[] = [];
const counts = new Map<string, number>();
const publicationCounts = new Map<string, number>();
const results: Record<string, unknown> = {};

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; toJSON?: () => { version?: string; message?: string } };
  let version: string | null = null;
  let message: string | null = null;
  try {
    const j = typeof e.toJSON === "function" ? e.toJSON() : undefined;
    version = j?.version ?? null;
    message = j?.message ?? null;
  } catch {
    version = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message };
};

let revisionIndex = 0;
const service = await openEvidenceWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(12, "0")}`,
  clock: () => payload.clockMs,
  sourceNamespace: null,
  onBoundary: async (boundary: string) => {
    publicationTrace.push(boundary);
    const seen = (publicationCounts.get(boundary) ?? 0) + 1;
    publicationCounts.set(boundary, seen);
    if (
      payload.failPublicationAt &&
      payload.failPublicationAt.boundary === boundary &&
      payload.failPublicationAt.occurrence === seen
    ) {
      throw new Error("commanded publication hook failure");
    }
  },
  onEvidenceBoundary: async (boundary: string) => {
    trace.push(boundary);
    const seen = (counts.get(boundary) ?? 0) + 1;
    counts.set(boundary, seen);
    if (payload.failAt && payload.failAt.boundary === boundary && payload.failAt.occurrence === seen) {
      throw new Error("commanded hook failure");
    }
  },
});

// Test-side dataset surgery, deliberately OUTSIDE the service.
//
// These are not production seams: they exist so a test can put the dataset
// into a state the service refuses to create -- a physically valid but
// underivable capture time, a duplicated node identity, a version that moves
// while a read is in flight. Nothing here is imported by src/.
const { tableFromArrays } = await import("apache-arrow");
// The ACCEPTED raw decoder, so a timestamp[us] column is read as exact
// micros. A plain `.toArray()` can hand back a lossy JS value, which would
// make a sub-millisecond probe silently unable to observe what it wrote.
const { rawRows } = await import(
  new URL("../../../../src/publication/storage.ts", import.meta.url).pathname
);
let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};
const addRow = async (name: string, row: Record<string, unknown>) => {
  const columns: Record<string, unknown[]> = {};
  for (const key of Object.keys(row)) columns[key] = [row[key]];
  await (await harnessTable(name)).add(tableFromArrays(columns as never) as never);
};

const LINK_COLUMNS = [
  "workspace_name", "revision_id", "position", "relation", "target_kind", "target",
  "target_key", "excerpt", "content_hash", "captured_at", "capture_status", "note",
] as const;

/**
 * A DETERMINISTIC interleave at the service's own nodes-version capture.
 *
 * The scan captures the witness, reads, then re-checks. Proving the re-check
 * needs a mutation that lands strictly between those two points, and a read
 * path has no boundary hook to hold -- so the seam is taken in the child, at
 * runtime, on the SDK's own prototype:
 *
 *   1. the first `version()` call on the tracked table calls the ORIGINAL and
 *      retains its result;
 *   2. the wrapper disarms (so neither the mutation's own version reads nor
 *      the observation below re-enter it);
 *   3. a REAL scoped mutation runs against the real dataset;
 *   4. the retained PRE-mutation value is returned to the caller.
 *
 * The service therefore captures a witness that is genuinely stale by the time
 * its own reads finish -- with real storage and real SDK calls throughout. The
 * descriptor is restored in a finally. Nothing on disk and nothing in src/ is
 * modified. This is instrumented interleaving evidence, NOT a claim about
 * uninstrumented concurrency.
 */
type VersionInterleave = {
  restore: () => void;
  state: { log: string[]; calls: number; observed: { before: string; after: string } | null };
};
const interleave: { current: VersionInterleave | null } = { current: null };

const harness: Record<string, (request: any) => Promise<unknown>> = {
  async armVersionInterleave(request) {
    if (interleave.current !== null) throw new Error("already armed");
    const tbl = await harnessTable(request.table);
    const proto = Object.getPrototypeOf(tbl);
    const descriptor = Object.getOwnPropertyDescriptor(proto, "version");
    // Pinned before use: an unwrappable descriptor is an obstacle to report,
    // never something to work around.
    if (descriptor === undefined || typeof descriptor.value !== "function") {
      throw new Error(`no version method on ${proto?.constructor?.name ?? "unknown"}`);
    }
    if (descriptor.configurable !== true) {
      throw new Error(`version descriptor on ${proto?.constructor?.name} is not configurable`);
    }
    const original = descriptor.value as (this: unknown, ...a: unknown[]) => Promise<number>;
    const state = { log: [] as string[], calls: 0, observed: null as { before: string; after: string } | null };
    let armed = true;
    Object.defineProperty(proto, "version", {
      ...descriptor,
      value: async function (this: { name?: string }, ...args: unknown[]) {
        // Tracked identity only: every other table keeps the real method.
        if (this?.name !== request.table) return original.apply(this, args);
        state.calls += 1;
        if (!armed) {
          const passthrough = await original.apply(this, args);
          state.log.push(`passthrough:${String(passthrough)}`);
          return passthrough;
        }
        const retained = await original.apply(this, args);
        // Disarm BEFORE mutating: the mutation and the observation below both
        // read the version themselves.
        armed = false;
        state.log.push(`captured:${String(retained)}`);
        await tbl.delete(request.predicate);
        const moved = await original.apply(tbl, []);
        state.observed = { before: String(retained), after: String(moved) };
        state.log.push(`mutated:${String(moved)}`);
        // The caller sees the PRE-mutation value. That is the interleave.
        return retained;
      },
    });
    interleave.current = { restore: () => Object.defineProperty(proto, "version", descriptor), state };
    return { armed: true, prototype: proto?.constructor?.name ?? null };
  },
  /** Raw rows as TEXT, so a bigint column survives JSON without loss. */
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, v === null || v === undefined ? null : String(v)]),
      ),
    );
  },
  async readVersionInterleave() {
    if (interleave.current === null) throw new Error("not armed");
    return { ...interleave.current.state };
  },
  /** Rewrite one derived link row's capture time to raw micros, losslessly. */
  async setLinkCapturedAtMicros(request) {
    const tbl = await harnessTable("revision_links");
    const where = `workspace_name = '${request.workspace_name}' AND revision_id = '${request.revision_id}'`;
    const rows = await rawRows(tbl, where);
    if (rows.length !== 1) throw new Error(`expected 1 link row, found ${rows.length}`);
    const source = rows[0] as Record<string, unknown>;
    await tbl.delete(where);
    const rebuilt: Record<string, unknown> = {};
    // utf8 columns round-trip exactly; the two numeric columns are rebuilt
    // from the request so no Number ever touches them.
    for (const column of LINK_COLUMNS) rebuilt[column] = source[column] ?? null;
    rebuilt.position = BigInt(request.position);
    rebuilt.captured_at = request.captured_at_micros === null ? null : BigInt(request.captured_at_micros);
    await addRow("revision_links", rebuilt);
    return { rewritten: true };
  },
  /** The RAW stored micros, as decimal text -- never a lossy Number. */
  async readLinkCapturedAtMicros(request) {
    const tbl = await harnessTable("revision_links");
    const rows = await rawRows(
      tbl,
      `workspace_name = '${request.workspace_name}' AND revision_id = '${request.revision_id}'`,
    );
    return rows.map((r: Record<string, unknown>) => {
      const raw = r.captured_at;
      if (raw === null || raw === undefined) return null;
      return typeof raw === "bigint" ? raw.toString(10) : String(raw);
    });
  },
  /** Append a node row verbatim -- used to duplicate an existing identity. */
  async appendNode(request) {
    await addRow("nodes", {
      id: request.id,
      workspace_name: request.workspace_name,
      current_revision_id: request.current_revision_id ?? null,
      created_at: BigInt(request.created_at_micros),
      updated_at: BigInt(request.updated_at_micros),
    });
    return { appended: request.id };
  },
  /**
   * Move the nodes version with a ZERO-MATCH delete, between two calls.
   *
   * Deterministic by construction: it is a complete, awaited op of its own, so
   * the next request is issued strictly after the version moved.
   */
  async bumpNodesVersion(request) {
    const tbl = await harnessTable("nodes");
    const before = await tbl.version();
    const result = (await tbl.delete(request.predicate)) as unknown as Record<string, unknown>;
    return {
      numDeletedRows: result?.numDeletedRows ?? null,
      versionMoved: (await tbl.version()) !== before,
    };
  },
  /**
   * Start a scan, then move the nodes table version while it is IN FLIGHT.
   *
   * A ZERO-MATCH delete, deliberately: it advances the version without
   * touching a row, so the dataset stays valid and the only thing the scan can
   * react to is the witness itself. The handle is opened BEFORE the scan
   * starts, so the interleaved work is one commit against an already-open
   * table while the scan is still doing per-node round trips.
   */
  async scanWithConcurrentVersionBump(request) {
    const tbl = await harnessTable("nodes");
    const before = await tbl.version();
    const scan = service.evidence.scanDependents(
      new TextEncoder().encode(JSON.stringify(request.scan)),
    );
    const bumped = tbl.delete(request.predicate).then(
      (r: unknown) => r as Record<string, unknown>,
      (e: unknown) => ({ error: String(e) }),
    );
    const value = await scan.then(
      (v: unknown) => ({ ok: true, value: v }),
      (e: unknown) => ({ ok: false, ...describeError(e) }),
    );
    await bumped;
    return {
      scan: value,
      bumped: await bumped,
      versionMoved: (await tbl.version()) !== before,
    };
  },
};

try {
for (const [index, op] of payload.ops.entries()) {
  if (op.facade === ("harness" as never)) {
    const label = `op${index}`;
    try {
      results[label] = { ok: true, value: await harness[op.method]!(op.request) };
    } catch (error) {
      results[label] = { ok: false, ...describeError(error) };
    }
    continue;
  }
  const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[
    op.facade ?? "evidence"
  ];
  const call = facade?.[op.method];
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

} finally {
  // The runtime patch NEVER outlives the ops, including on a thrown op.
  interleave.current?.restore();
}

results.writerKeys = Object.keys(service).sort();
results.evidenceMethods = Object.keys(service.evidence).sort();
results.evidenceHasClose = "close" in service.evidence;

try {
  await service.close();
} catch {
  // A poisoned owner may refuse close paths; that is not what this measures.
}

const conn = await connect(datasetRoot!, { readConsistencyInterval: 0 });
const rowsOf = async (table: string) => {
  const rows = await (await conn.openTable(table)).query().toArray();
  return rows.map((r: Record<string, unknown>) => `${r.workspace_name}|${r.revision_id}|${r.position}`).sort();
};
results.persistedTerms = await rowsOf("node_revision_terms");
results.persistedLinks = await rowsOf("revision_links");
results.trace = trace;
results.publicationTrace = publicationTrace;

console.log(JSON.stringify(results));
