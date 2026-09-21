/**
 * Owned gated child for the session-link-v1 precision fixtures.
 *
 * Shaped after `fixtures/read-cursor-v1/precision/seed-child.ts`: a small
 * step-driven plan interpreter, run INSIDE the real inherited writer gate
 * (`exec_with_gate` already holds it before this program starts). Two roles:
 *
 *   PREPARATION -- `seed`. Raw Arrow appends, including states no service
 *   path can produce: a sub-millisecond `created_at` remainder, an
 *   out-of-Gregorian-range timestamp, and a tied-`created_at` fan of rows
 *   whose ONLY deterministic order is `id` (per §"Keyset ordered by id ONLY"
 *   in service.ts's `listSessionLinks`).
 *
 *   ASSERTED BEHAVIOUR -- `action`. Opens the real `openContextWriter` and
 *   calls the contracted `context` methods (`createSessionLink`,
 *   `listSessionLinks`). Nothing here interprets the result.
 *
 * This file is INDEPENDENT of the accepted core fixture
 * (`fixtures/session-link-v1/core/gated-session-link.ts`): that one is owned
 * by the ownership/recovery lanes running in parallel tonight, and a shared
 * script two lanes both edit is how one slice's changes quietly become the
 * other's. Precision gets its own copy, deliberately duplicated.
 */

import { readFileSync } from "node:fs";
import { connect } from "@lancedb/lancedb";
import { tableFromArrays } from "apache-arrow";
import { rawRows } from "../../../../src/publication/storage";
import * as service from "../../../../src/publication/service";

/** Literal physical field order, transcribed from target_v1/ and session-link.ts. */
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
  session_links: [
    "id", "workspace_name", "from_session_name", "to_session_name",
    "relation", "evidence_ref", "created_by_peer_name", "created_at",
  ],
};

/** timestamp[us] columns; the plan carries RAW MICROSECONDS as decimal text so
 *  a sub-millisecond remainder is expressible at all. */
const MICROS: Record<string, readonly string[]> = {
  peers: ["created_at"],
  sessions: ["created_at"],
  session_peers: ["joined_at", "left_at"],
  session_links: ["created_at"],
};

type Step =
  | { op: "seed"; table: string; rows: Record<string, unknown>[]; probe?: boolean }
  | { op: "snapshot"; tables: string[] }
  | { op: "rows"; table: string; predicate: string }
  | {
      op: "action";
      clock: { mode: "fixed"; ms: number } | { mode: "throw" };
      actions: { method: string; request: unknown }[];
    };

type Plan = { datasetRoot: string; steps: Step[] };

/** A THROWING clock turns "this path samples no clock" into a failure mode. */
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
  const micros = new Set(MICROS[table] ?? []);
  const out: Record<string, unknown> = {};
  for (const field of FIELDS[table]!) {
    const value = input[field] ?? null;
    // Decimal text -> BigInt. Never a JS number: a number timestamp is
    // accepted and silently corrupts what is stored (measured elsewhere).
    out[field] = value !== null && micros.has(field) ? BigInt(value as string) : value;
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
        // ADMISSION PROBE: the try wraps ONLY the SDK `add` call. Plan
        // parsing, conversion and Arrow construction have already succeeded,
        // so a failure caught here can only be the store refusing the value.
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

      await handle.add(arrow);
      results.push({
        op: step.op, table: step.table, added: step.rows.length, version: await handle.version(),
      });
      continue;
    }

    if (step.op === "action") {
      const open = (service as unknown as Record<string, unknown>).openContextWriter as
        (root: string, options: unknown) => Promise<Record<string, unknown>>;
      const writer = await open(plan.datasetRoot, {
        sourceNamespace: null,
        clock: clockFor(step.clock),
        // Session-link operations allocate no revision id.
        newRevisionId: () => {
          throw new Error("session-link operations must not allocate a revision id");
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
