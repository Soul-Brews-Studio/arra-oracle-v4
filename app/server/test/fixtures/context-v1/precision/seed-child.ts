/**
 * Owned gated child for the #28 precision/order fixtures.
 *
 * `exec_with_gate` replaces a Python launcher with this program, so it already
 * holds the writer gate and fd 42 by the time it runs. Every write below is a
 * legitimate gated write into a DISPOSABLE dataset the bare taxonomy exporter
 * just created — never a live one, and never a second dataset creator.
 *
 * It is a dumb executor on purpose. The test decides every identifier, ordinal,
 * timestamp and padding length; this file only converts wire values to physical
 * ones and appends. Keeping the decisions in the test is what lets the test
 * compute its expected wire bytes and orderings independently of any product
 * encoder.
 *
 * Two things it does deliberately that the kernel cannot:
 *
 * * It writes RAW microsecond values, including ones with a non-zero remainder
 *   modulo 1000. The service refuses sub-millisecond rows, so the only way to
 *   prove that refusal is to put such a row on disk first.
 * * It writes legacy-shaped extremes — negative ids, values beyond 2^53, the
 *   Int64 ceiling, and duplicate keys — which no service path would allocate.
 */

import { readFileSync } from "node:fs";
import { connect } from "@lancedb/lancedb";
import { tableFromArrays } from "apache-arrow";
import * as service from "../../../../src/publication/service";

/** Literal physical field order, transcribed from target_v1/core.py. */
const FIELDS: Record<string, readonly string[]> = {
  peers: ["id", "name", "workspace_name", "h_metadata", "internal_metadata", "configuration", "created_at"],
  sessions: [
    "id", "name", "workspace_name", "is_active",
    "h_metadata", "internal_metadata", "configuration", "created_at",
  ],
  session_peers: [
    "workspace_name", "session_name", "peer_name",
    "configuration", "internal_metadata", "joined_at", "left_at",
  ],
  messages: [
    "id", "public_id", "workspace_name", "session_name", "peer_name", "content",
    "token_count", "seq_in_session", "h_metadata", "internal_metadata", "created_at",
    "role", "in_reply_to", "read", "read_at",
    "source_namespace", "source_message_id", "source_payload_digest", "source_created_at",
    "ingested_at",
  ],
};

/** Int64 columns: decimal text on the wire, BigInt in Arrow. */
const INT64: Record<string, readonly string[]> = {
  peers: [],
  sessions: [],
  session_peers: [],
  messages: ["id", "token_count", "seq_in_session"],
};

/**
 * timestamp[us] columns. The plan carries RAW MICROSECONDS as decimal text,
 * not an ISO string, precisely so a sub-millisecond value is expressible.
 */
const MICROS: Record<string, readonly string[]> = {
  peers: ["created_at"],
  sessions: ["created_at"],
  session_peers: ["joined_at", "left_at"],
  messages: ["created_at", "read_at", "source_created_at", "ingested_at"],
};

type Step =
  | { op: "seed"; table: string; rows: Record<string, unknown>[] }
  | { op: "snapshot"; tables: string[] }
  | {
      op: "context";
      sourceNamespace: string | null;
      actions: { method: string; request: unknown }[];
    };

type Plan = { datasetRoot: string; steps: Step[] };

function physical(table: string, input: Record<string, unknown>): Record<string, unknown> {
  // `content_pad` keeps a 16 MiB plan file small: the test sends a COUNT and
  // both sides expand it identically. 'a' is one UTF-8 byte and JSON.stringify
  // never escapes it, so one pad unit is exactly one wire byte.
  const pad = typeof input.content_pad === "number" ? input.content_pad : 0;
  const wire: Record<string, unknown> =
    pad > 0 ? { ...input, content: `${String(input.content ?? "")}${"a".repeat(pad)}` } : { ...input };
  delete wire.content_pad;

  const int64 = new Set(INT64[table] ?? []);
  const micros = new Set(MICROS[table] ?? []);
  const out: Record<string, unknown> = {};
  for (const field of FIELDS[table]!) {
    const value = wire[field] ?? null;
    if (value !== null && (int64.has(field) || micros.has(field))) {
      // Decimal text -> BigInt. Never a JS number: measured on this stack, a
      // number timestamp is accepted and silently corrupts what is stored.
      out[field] = BigInt(value as string);
    } else {
      out[field] = value;
    }
  }
  return out;
}

async function main(): Promise<number> {
  const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Plan;
  const connection = await connect(plan.datasetRoot, { readConsistencyInterval: 0 });
  const results: unknown[] = [];

  for (const step of plan.steps) {
    if (step.op === "seed") {
      const handle = await connection.openTable(step.table);
      // ONE batched add per table: a 1024-row chain appended row by row would
      // be 1024 dataset versions of pure setup.
      const columns: Record<string, unknown[]> = {};
      for (const row of step.rows) {
        const built = physical(step.table, row);
        for (const field of FIELDS[step.table]!) (columns[field] ??= []).push(built[field]);
      }
      await handle.add(tableFromArrays(columns as never) as never);
      results.push({ op: step.op, table: step.table, added: step.rows.length, version: await handle.version() });
      continue;
    }
    if (step.op === "context") {
      // EVERY service WRITER operation runs here, inside the gate.
      //
      // The parent cannot do this: the bare fixture exporter acquires the gate,
      // finishes and RELEASES it, so a parent-side openContextWriter would fail
      // writer_unavailable at assertInheritedGate before reaching any behaviour
      // under test. One writer per gated process is also the rule, because
      // close() releases the inherited descriptor and it cannot be retaken.
      // Namespace access, not a named import: the export does not exist yet and
      // a named import would be a link error that breaks typecheck rather than
      // a runtime absence the parent already gates on.
      const openContextWriter = (service as unknown as Record<string, unknown>).openContextWriter as
        | ((root: string, options: unknown) => Promise<unknown>)
        | undefined;
      if (typeof openContextWriter !== "function") {
        throw new Error("openContextWriter absent from publication/service");
      }
      const writer = await openContextWriter(plan.datasetRoot, {
        sourceNamespace: step.sourceNamespace,
        // Required by the factory options even though context operations never
        // allocate a revision id. Throwing proves that: if the kernel ever
        // called it, the test would fail loudly instead of silently tolerating
        // an allocator this slice has no business using.
        newRevisionId: () => {
          throw new Error("context operations must not allocate a revision id");
        },
      } as never);
      const actions: unknown[] = [];
      try {
        for (const action of step.actions) {
          const method = (writer as unknown as Record<string, Record<string, unknown>>).context[
            action.method
          ] as (bytes: Uint8Array) => Promise<unknown>;
          const bytes = new TextEncoder().encode(JSON.stringify(action.request));
          try {
            actions.push({ method: action.method, ok: true, result: await method(bytes) });
          } catch (error) {
            // Thrown errors are reported with BOTH the constructor name and the
            // envelope, so the parent can assert all four fields. Stopped
            // results are values, not throws, and arrive through ok:true.
            const shaped = error as { name?: string; toJSON?: () => unknown };
            actions.push({
              method: action.method,
              ok: false,
              name: shaped.name ?? null,
              error: shaped.toJSON?.() ?? { message: String(error) },
            });
          }
        }
      } finally {
        await (writer as unknown as { close(): Promise<void> }).close();
      }
      results.push({ op: step.op, actions });
      continue;
    }

    const snapshot: Record<string, unknown> = {};
    for (const name of step.tables) {
      const handle = await connection.openTable(name);
      await handle.checkoutLatest();
      snapshot[name] = { version: await handle.version(), rows: await handle.countRows() };
    }
    results.push({ op: step.op, snapshot });
  }

  process.stdout.write(`${JSON.stringify({ results })}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${String((error as Error)?.stack ?? error)}\n`);
    process.exit(1);
  },
);
