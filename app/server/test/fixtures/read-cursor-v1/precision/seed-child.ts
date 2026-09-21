/**
 * Owned gated child for the #74 read-cursor precision fixtures.
 *
 * `exec_with_gate` replaces a Python launcher with this program, so it already
 * holds the real inherited writer gate and fd 42. Every write below is a
 * legitimate gated write into a DISPOSABLE dataset the accepted bare taxonomy
 * fixture just created — never a live one, and never a second dataset creator.
 *
 * Two roles, kept apart:
 *
 *   PREPARATION — `seed`. Raw Arrow appends of cursor rows, messages and
 *   registration rows, including states no service path can produce: negative
 *   and beyond-2^53 sequences, duplicate logical keys, non-nanoid retained
 *   pointers and sub-millisecond timestamps. Message digests come from the
 *   protected codec so a seeded row is genuinely canonical.
 *
 *   ASSERTED BEHAVIOUR — `cursor`. Opens the real context writer and calls the
 *   contracted methods. Nothing here interprets the result.
 *
 * All WRITER calls live here because the bare exporter takes the gate, finishes
 * and RELEASES it: a parent-side writer would fail `writer_unavailable` at the
 * gate check before reaching any behaviour under test. Readers need no gate and
 * stay in the parent.
 */

import { readFileSync } from "node:fs";
import { connect } from "@lancedb/lancedb";
import { tableFromArrays } from "apache-arrow";
import { rawRows } from "../../../../src/publication/storage";
import * as service from "../../../../src/publication/service";

/** Literal physical field order, transcribed from target_v1/. */
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
  read_cursors: [
    "workspace_name", "peer_name", "session_name", "last_read_message_id", "last_read_at",
  ],
};

const INT64: Record<string, readonly string[]> = {
  peers: [], sessions: [], session_peers: [], read_cursors: [],
  messages: ["id", "token_count", "seq_in_session"],
};

/** timestamp[us]; the plan carries RAW MICROSECONDS as decimal text, so a
 *  sub-millisecond remainder is expressible at all. */
const MICROS: Record<string, readonly string[]> = {
  peers: ["created_at"],
  sessions: ["created_at"],
  session_peers: ["joined_at", "left_at"],
  messages: ["created_at", "read_at", "source_created_at", "ingested_at"],
  read_cursors: ["last_read_at"],
};

type Step =
  | { op: "seed"; table: string; rows: Record<string, unknown>[]; probe?: boolean }
  | { op: "snapshot"; tables: string[] }
  | { op: "rows"; table: string; predicate: string }
  | {
      op: "cursor";
      sourceNamespace: string | null;
      clock: { mode: "fixed"; ms: number } | { mode: "throw" };
      actions: { method: string; request: unknown }[];
    };

type Plan = { datasetRoot: string; steps: Step[] };

/**
 * A THROWING clock is how "this path samples no clock" becomes a failure mode
 * instead of an untested comment. §4 rules 1-3 forbid a sample on replay and on
 * both conflict classifications.
 */
function clockFor(spec: { mode: "fixed"; ms: number } | { mode: "throw" }): () => number {
  if (spec.mode === "throw") {
    return () => {
      throw new Error("clock sampled on a path that must not sample it");
    };
  }
  const ms = spec.ms;
  return () => ms;
}

function physical(table: string, input: Record<string, unknown>): Record<string, unknown> {
  const int64 = new Set(INT64[table] ?? []);
  const micros = new Set(MICROS[table] ?? []);
  const out: Record<string, unknown> = {};
  for (const field of FIELDS[table]!) {
    const value = input[field] ?? null;
    // Decimal text -> BigInt. Never a JS number: measured on this stack, a
    // number timestamp is accepted and silently corrupts what is stored.
    out[field] = value !== null && (int64.has(field) || micros.has(field))
      ? BigInt(value as string)
      : value;
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
      const columns: Record<string, unknown[]> = {};
      for (const row of step.rows) {
        const built = physical(step.table, row);
        for (const field of FIELDS[step.table]!) (columns[field] ??= []).push(built[field]);
      }
      const arrow = tableFromArrays(columns as never) as never;

      if (step.probe === true) {
        // ADMISSION PROBE. The try wraps the SDK `add` call and NOTHING else:
        // plan parsing, value conversion and Arrow construction have already
        // succeeded above, so a failure caught here can only be the store
        // refusing the value. A broader catch would turn a child launch fault,
        // a gate error, a timeout or a malformed plan into "the engine refused
        // it", which is a different claim entirely and would read as green.
        try {
          await handle.add(arrow);
          results.push({
            op: step.op, table: step.table, admitted: true,
            added: step.rows.length, version: await handle.version(),
          });
        } catch (error) {
          const shaped = error as { name?: string; message?: string };
          results.push({
            op: step.op, table: step.table, admitted: false,
            refusal: { name: shaped.name ?? null, message: String(shaped.message ?? error) },
          });
        }
        continue;
      }

      // Ordinary seeding stays FATAL: a failure here is a broken fixture and
      // must surface as a nonzero child exit, never as a quiet result.
      await handle.add(arrow);
      results.push({
        op: step.op, table: step.table, added: step.rows.length, version: await handle.version(),
      });
      continue;
    }

    if (step.op === "cursor") {
      // Namespace access, not a named import: the methods do not exist yet and
      // a named import would be a link error breaking typecheck rather than a
      // runtime absence the parent already gates on.
      const open = (service as unknown as Record<string, unknown>).openContextWriter as
        | ((root: string, options: unknown) => Promise<unknown>)
        | undefined;
      if (typeof open !== "function") throw new Error("openContextWriter absent");

      const writer = await open(plan.datasetRoot, {
        sourceNamespace: step.sourceNamespace,
        // A THROWING clock is how "this path samples no clock" becomes a
        // failure mode instead of an untested comment. §4 rules 1-3 forbid a
        // sample on replay and on both conflict classifications.
        clock: clockFor(step.clock),
        // Cursor operations allocate no revision id; §1 forbids it outright.
        newRevisionId: () => {
          throw new Error("cursor operations must not allocate a revision id");
        },
      });
      const actions: unknown[] = [];
      try {
        for (const action of step.actions) {
          const facade = (writer as Record<string, Record<string, unknown>>).context;
          const method = facade[action.method] as ((bytes: Uint8Array) => Promise<unknown>) | undefined;
          if (typeof method !== "function") {
            actions.push({ method: action.method, ok: false, name: null, error: { absent: true } });
            continue;
          }
          const bytes = new TextEncoder().encode(JSON.stringify(action.request));
          try {
            actions.push({ method: action.method, ok: true, result: await method.call(facade, bytes) });
          } catch (error) {
            // Both the constructor name and the envelope, so the parent can
            // assert all four wire fields plus the name on a thrown instance.
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
        await (writer as { close(): Promise<void> }).close();
      }
      results.push({ op: step.op, actions });
      continue;
    }

    if (step.op === "rows") {
      // LOSSLESS physical dump. A version-and-count snapshot cannot support a
      // five-field storage claim: an `advanced` response can be exactly right
      // while the row on disk is wrong, and counts would not notice. Raw
      // microseconds are read through the accepted decoder and emitted as
      // canonical decimal TEXT, because a JS number here would lose precisely
      // the precision the assertion exists to check.
      const handle = await connection.openTable(step.table);
      await handle.checkoutLatest();
      const raw = await rawRows(handle, step.predicate);
      const rows = raw.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) {
          out[key] = typeof value === "bigint" ? value.toString(10) : value;
        }
        return out;
      });
      results.push({ op: step.op, table: step.table, rows, version: await handle.version() });
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
