// Owned gated child for #30's embed-worker tests (`search-chunk-embed-worker.test.ts`).
// Runs INSIDE the real gate. Shaped after the accepted
// `core/gated-search.ts`: the same ops-array dispatch over `publication`,
// `context` and `harness`, plus:
//
//  - `payload.embedTimeoutMs` sets `ARRA_EMBED_TIMEOUT_MS` in THIS process's
//    env BEFORE `service.ts` (and therefore `service.embedPendingChunks.ts`)
//    is ever imported -- the same "env read at import" convention
//    `storage.ts`'s `ARRA_DATA_DIR` already relies on, so a test can force a
//    short timeout without waiting out the real 30s default.
//  - `payload.embedderMode` selects a STUB embedder, never a real network
//    call: "none" (omit the option entirely), "fixed" (deterministic
//    per-text vectors, call args recorded), "hang" (a promise that never
//    settles), "reject-once" (the first call rejects, every later call
//    succeeds with a fixed vector).
//  - `op.concurrent: Op[]` runs every listed op via `Promise.all` and
//    records each sub-result under its own index -- how the hang test
//    proves `publishRevision` is never blocked by a concurrent
//    `embedPendingChunks` call stuck in its embedder.
//  - R20 (docs/overnight/DECISIONS.md): `payload.digests` scripts the STUB
//    model-digest probe, one entry per probe call (the last entry repeats):
//    a digest string is a measurement, `null` is "Ollama answered nothing
//    usable", `"hang"` never settles. Absent means one fixed stub digest
//    for every call, so tests about something else are never blocked;
//    `"none"` omits the probe option entirely. `payload.digestTimeoutMs`
//    sets `ARRA_EMBED_DIGEST_TIMEOUT_MS` before import, like
//    `embedTimeoutMs`. Never a real network call.
type Op = { facade?: "context" | "publication" | "taxonomy" | "harness"; method: string; request: any };

const [, , datasetRoot, payloadJson] = Bun.argv;
const payload = JSON.parse(payloadJson ?? "{}") as {
  ops: Array<
    | Op
    | { concurrent: Op[] }
    // Fix round finding 6a: a DETERMINISTIC alternative to `concurrent` --
    // `second` starts only once the stub embedder has genuinely been
    // invoked for `first` (a real handshake, not a hope about scheduling
    // order). See the module header and the `embedderInvokedPromise` below.
    | { handshake: { first: Op; second: Op } }
  >;
  clockMs?: number;
  revisionIds?: string[];
  embedTimeoutMs?: number;
  embedderMode?: "none" | "fixed" | "hang" | "reject-once" | "always-fail" | "short-batch" | "wrong-dims" | "nan-values";
  embedDims?: number;
  digests?: Array<string | null> | "none";
  digestTimeoutMs?: number;
};

if (payload.embedTimeoutMs !== undefined) {
  process.env.ARRA_EMBED_TIMEOUT_MS = String(payload.embedTimeoutMs);
}
if (payload.digestTimeoutMs !== undefined) {
  process.env.ARRA_EMBED_DIGEST_TIMEOUT_MS = String(payload.digestTimeoutMs);
}

const servicePath = new URL("../../../../src/publication/service.ts", import.meta.url).pathname;
const { openContextWriter } = await import(servicePath);
const { rawRows } = await import(new URL("../../../../src/publication/storage.ts", import.meta.url).pathname);
const { connect } = await import("@lancedb/lancedb");
const { activeEmbeddingProfileId } = await import(
  new URL("../../../../src/publication/search-chunk.ts", import.meta.url).pathname
);
const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");

/** The one stub digest every probe call answers when a test does not script
 *  `payload.digests` -- the measured `/api/tags` shape (64 lowercase hex). */
const DEFAULT_STUB_DIGEST = "0d1a2b3c4d5e6f708192a3b4c5d6e7f80d1a2b3c4d5e6f708192a3b4c5d6e7f8";
const digestScript: Array<string | null> =
  payload.digests === undefined || payload.digests === "none" ? [DEFAULT_STUB_DIGEST] : payload.digests;
let probeCalls = 0;
const digestProbe =
  payload.digests === "none"
    ? undefined
    : async (_signal?: AbortSignal): Promise<string | null> => {
        const answer = digestScript[Math.min(probeCalls, digestScript.length - 1)] ?? null;
        probeCalls += 1;
        if (answer === "hang") {
          return new Promise<string | null>(() => {
            /* never resolves, and ignores the signal on purpose */
          });
        }
        return answer;
      };

const DIMS = payload.embedDims ?? 384;
const embedCalls: string[][] = [];
let rejectOnceUsed = false;

/**
 * Fix round finding 6a: resolved the FIRST time the stub embedder is
 * actually invoked, for ANY mode. A `{handshake: {first, second}}` op
 * awaits this before starting `second` -- proof that the embedder call is
 * genuinely in flight (and, for `hang`, genuinely stuck) when the
 * concurrent write begins, rather than hoping `Promise.all` schedules it
 * that way.
 */
let embedderInvokedResolve: (() => void) | null = null;
const embedderInvokedPromise = new Promise<void>((resolve) => {
  embedderInvokedResolve = resolve;
});

function fixedVector(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => ((seed + i) % 97) / 97);
}

const embedder =
  payload.embedderMode === undefined || payload.embedderMode === "none"
    ? undefined
    : async (texts: string[], _signal?: AbortSignal): Promise<number[][]> => {
        embedCalls.push(texts);
        embedderInvokedResolve?.();
        if (payload.embedderMode === "hang") {
          return new Promise<number[][]>(() => {
            /* never resolves */
          });
        }
        if (payload.embedderMode === "reject-once" && !rejectOnceUsed) {
          rejectOnceUsed = true;
          throw new Error("503 service unavailable");
        }
        if (payload.embedderMode === "always-fail") {
          throw new Error("503 service unavailable, every time");
        }
        // Fix round finding 2 -- three shapes of "the embedder answered but
        // the answer is out of contract", each of which must become a
        // closed `embedder_bad_response` failure, never a write attempt:
        if (payload.embedderMode === "short-batch") {
          // One fewer vector than texts requested.
          return texts.slice(1).map((text, i) => fixedVector(text.length + i));
        }
        if (payload.embedderMode === "wrong-dims") {
          // Right count, wrong width (simulates `EMBEDDING_DIMENSIONS`
          // misconfigured away from the frozen physical 384).
          return texts.map((text, i) => fixedVector(text.length + i).slice(0, DIMS - 1));
        }
        if (payload.embedderMode === "nan-values") {
          return texts.map((text, i) => {
            const vector = fixedVector(text.length + i);
            vector[0] = Number.NaN;
            return vector;
          });
        }
        return texts.map((text, i) => fixedVector(text.length + i));
      };

let harnessConn: Awaited<ReturnType<typeof connect>> | null = null;
const harnessTable = async (name: string) => {
  harnessConn ??= await connect(datasetRoot!, { readConsistencyInterval: 0 });
  const tbl = await harnessConn.openTable(name);
  await tbl.checkoutLatest();
  return tbl;
};

const harness: Record<string, (request: any) => Promise<unknown>> = {
  /** R20: the dataset's pin sidecar, read raw -- the parent asserts its
   *  exact content, so this never goes through the production reader. */
  async readPinFile() {
    const path = join(datasetRoot!, ".embedding-profile-pins.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  },
  /** Plant raw pin-file text: how a test damages the pin on purpose. */
  async writePinFile(request) {
    writeFileSync(join(datasetRoot!, ".embedding-profile-pins.json"), String(request.text), "utf8");
    return null;
  },
  /** The profile id THIS process's module instance computes right now. */
  async profileId() {
    return activeEmbeddingProfileId();
  },
  async readRawRows(request) {
    const tbl = await harnessTable(request.table);
    const rows = await rawRows(tbl, request.predicate);
    return rows.map((r: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === undefined) {
          out[k] = null;
        } else if (typeof v === "bigint") {
          out[k] = v.toString(10);
        } else if (k === "embedding" || k === "term_ids") {
          // Only ever inspected for shape (populated vs not) in this fixture,
          // never for exact values -- a raw Arrow Vector's own `.toArray()`
          // is enough here, unlike `core/gated-search.ts`'s more exhaustive
          // shape reporting.
          out[k] = typeof (v as { toArray?: unknown }).toArray === "function"
            ? Array.from((v as { toArray(): unknown[] }).toArray())
            : v;
        } else {
          out[k] = v;
        }
      }
      return out;
    });
  },
};

const trace: string[] = [];
const results: Record<string, unknown> = {};

const describeError = (error: unknown): Record<string, unknown> => {
  const e = error as { name?: string; code?: string; path?: string; message?: string; toJSON?: () => { version?: string; message?: string } };
  let version: string | null = null;
  let message: string | null = null;
  try {
    const j = typeof e.toJSON === "function" ? e.toJSON() : undefined;
    version = j?.version ?? null;
    message = j?.message ?? e.message ?? null;
  } catch {
    version = null;
    message = e?.message ?? null;
  }
  let envelope: unknown = null;
  try {
    envelope = typeof e.toJSON === "function" ? e.toJSON() : null;
  } catch {
    envelope = null;
  }
  return { name: e.name ?? null, code: e.code ?? null, path: e.path ?? null, version, message, envelope };
};

let revisionIndex = 0;
const service = await openContextWriter(datasetRoot!, {
  newRevisionId: () => payload.revisionIds?.[revisionIndex++] ?? `fallback${String(revisionIndex).padStart(12, "0")}`,
  clock: () => payload.clockMs ?? 1_758_412_800_000,
  sourceNamespace: null,
  // The embed worker's DOCUMENT embedder is a WRITER option, named apart from
  // the reader-only query `embedder` (integration merge with #30 retrieval).
  documentEmbedder: embedder,
  digestProbe,
  onContextBoundary: async (boundary: string) => {
    trace.push(boundary);
  },
});

async function runOp(op: Op): Promise<Record<string, unknown>> {
  if (op.facade === "harness") {
    return { ok: true, value: await harness[op.method]!(op.request) };
  }
  const facade = (service as Record<string, Record<string, (b: Uint8Array) => Promise<unknown>>>)[
    op.facade ?? "context"
  ];
  const call = facade?.[op.method];
  if (typeof call !== "function") return { ok: false, code: "no_such_method" };
  try {
    return { ok: true, value: await call(new TextEncoder().encode(JSON.stringify(op.request))) };
  } catch (error) {
    return { ok: false, ...describeError(error) };
  }
}

try {
  for (const [index, op] of payload.ops.entries()) {
    const label = `op${index}`;
    if ("concurrent" in op) {
      const batchStarted = Bun.nanoseconds();
      const settled = await Promise.all(
        op.concurrent.map(async (sub) => {
          const subStarted = Bun.nanoseconds();
          const outcome = await runOp(sub);
          return { ...outcome, elapsedMs: (Bun.nanoseconds() - subStarted) / 1_000_000 };
        }),
      );
      results[label] = { concurrent: settled, elapsedMs: (Bun.nanoseconds() - batchStarted) / 1_000_000 };
      continue;
    }
    if ("handshake" in op) {
      const batchStarted = Bun.nanoseconds();
      const firstStarted = Bun.nanoseconds();
      const firstPromise = runOp(op.handshake.first).then((outcome) => ({
        ...outcome,
        elapsedMs: (Bun.nanoseconds() - firstStarted) / 1_000_000,
      }));
      // The load-bearing wait: `second` never starts until the stub
      // embedder inside `first` has genuinely been called.
      await embedderInvokedPromise;
      const secondStarted = Bun.nanoseconds();
      const secondOutcome = await runOp(op.handshake.second);
      const second = { ...secondOutcome, elapsedMs: (Bun.nanoseconds() - secondStarted) / 1_000_000 };
      const first = await firstPromise;
      results[label] = { first, second, elapsedMs: (Bun.nanoseconds() - batchStarted) / 1_000_000 };
      continue;
    }
    results[label] = await runOp(op);
  }
} finally {
  results.trace = trace;
  results.embedCalls = embedCalls;
  results.probeCalls = probeCalls;
}

console.log(JSON.stringify(results));
await service.close();
