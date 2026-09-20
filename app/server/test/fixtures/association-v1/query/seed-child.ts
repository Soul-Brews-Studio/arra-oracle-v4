/**
 * Owned gated child for the #68 association query fixtures.
 *
 * `exec_with_gate` replaces a Python launcher with this program, so it already
 * holds the writer gate and fd 42. Every write is a gated write into a
 * DISPOSABLE dataset the accepted bare taxonomy fixture just created.
 *
 * Two roles, kept apart on purpose:
 *
 *   PREPARATION — `seed`. Raw Arrow appends of accepted revisions, node heads
 *   and deliberately divergent derived projection rows. None of it is an
 *   assertion; it is how states the kernel has no API to produce (an orphan
 *   revision, a projection with a wrong field, an extra row) reach disk at all.
 *   Digests come from the protected revision codec, so a seeded revision is
 *   genuinely canonical rather than merely shaped like one.
 *
 *   ASSERTED BEHAVIOUR — `evidence`. Opens the real evidence writer and runs
 *   the contracted methods. Nothing here interprets the result.
 *
 * All WRITER calls live here because the bare fixture exporter takes the gate,
 * finishes and RELEASES it: a parent-side writer would fail writer_unavailable
 * at the gate check before reaching anything under test. Readers need no gate
 * and stay in the parent.
 */

import { readFileSync } from "node:fs";
import { connect } from "@lancedb/lancedb";
import { tableFromArrays } from "apache-arrow";
import { revisionOp } from "../../../../src/contracts/revision-v1";
import * as service from "../../../../src/publication/service";

/** Literal physical field order, transcribed from target_v1/. */
const FIELDS: Record<string, readonly string[]> = {
  nodes: ["id", "workspace_name", "current_revision_id", "created_at", "updated_at"],
  node_revisions: [
    "id", "workspace_name", "node_id", "revision_no", "base_revision_id", "operation_id",
    "title", "body", "body_format", "fields",
    "author_peer_name", "observer_peer_name", "subject_peer_name", "session_name",
    "is_active", "valid_from", "valid_to", "change_reason", "created_at",
    "schema_version", "canonical_version", "content_digest",
    "term_snapshot_json", "link_snapshot_json", "h_metadata", "internal_metadata",
  ],
  node_revision_terms: [
    "workspace_name", "revision_id", "term_id", "vocabulary_id",
    "vocabulary_name_snapshot", "term_name_snapshot", "label_snapshot", "position",
  ],
  revision_links: [
    "workspace_name", "revision_id", "position", "relation", "target_kind", "target",
    "target_key", "excerpt", "content_hash", "captured_at", "capture_status", "note",
  ],
};

const INT64: Record<string, readonly string[]> = {
  nodes: [],
  node_revisions: ["revision_no", "schema_version"],
  node_revision_terms: ["position"],
  revision_links: ["position"],
};

/** timestamp[us]; the plan carries RAW MICROSECONDS as decimal text. */
const MICROS: Record<string, readonly string[]> = {
  nodes: ["created_at", "updated_at"],
  node_revisions: ["valid_from", "valid_to", "created_at"],
  node_revision_terms: [],
  revision_links: ["captured_at"],
};

/** The 21 governed envelope keys, in codec order. */
const ENVELOPE_KEYS = [
  "workspace_name", "node_id", "base_revision_id",
  "title", "body", "body_format", "fields",
  "author_peer_name", "observer_peer_name", "subject_peer_name", "session_name",
  "is_active", "valid_from", "valid_to", "change_reason",
  "schema_version", "canonical_version",
  "term_snapshot_json", "link_snapshot_json",
  "h_metadata", "internal_metadata",
] as const;

type Step =
  | { op: "seed"; table: string; rows: Record<string, unknown>[] }
  | { op: "snapshot"; tables: string[] }
  | {
      op: "evidence";
      sourceNamespace: string | null;
      actions: { method: string; request: unknown }[];
    };

type Plan = { datasetRoot: string; steps: Step[] };

function physical(table: string, input: Record<string, unknown>): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...input };

  if (table === "node_revisions") {
    // `excerpt_pads` keeps a multi-megabyte plan file small: the test sends one
    // padding COUNT per link and both sides expand it the same way. 'a' is a
    // single UTF-8 byte that JSON.stringify never escapes, so one pad unit is
    // exactly one wire byte and a 16 MiB response case costs a few hundred
    // bytes of plan instead of sixteen megabytes.
    const pads = wire.excerpt_pads as number[] | undefined;
    delete wire.excerpt_pads;
    if (pads !== undefined) {
      const entries = JSON.parse(String(wire.link_snapshot_json)) as Record<string, unknown>[];
      if (entries.length !== pads.length) {
        throw new Error(`excerpt_pads length ${pads.length} != link count ${entries.length}`);
      }
      for (let index = 0; index < entries.length; index++) {
        const pad = pads[index] ?? 0;
        if (pad > 0) {
          entries[index]!.excerpt = `${String(entries[index]!.excerpt ?? "")}${"a".repeat(pad)}`;
        }
      }
      wire.link_snapshot_json = JSON.stringify(entries);
    }

    // Real canonical digest from the protected codec. A hand-written digest
    // would make every integrity and reconciliation assertion vacuous.
    const envelope = new Map<string, unknown>();
    for (const key of ENVELOPE_KEYS) envelope.set(key, wire[key] ?? null);
    const validated = revisionOp(envelope as never, []);
    const columns = validated.columns as unknown as Record<string, unknown>;
    wire.content_digest = validated.content_digest;
    wire.fields = columns.fields;
    wire.term_snapshot_json = columns.term_snapshot_json;
    wire.link_snapshot_json = columns.link_snapshot_json;
    wire.h_metadata = columns.h_metadata ?? null;
    wire.internal_metadata = columns.internal_metadata ?? null;
  }

  const int64 = new Set(INT64[table] ?? []);
  const micros = new Set(MICROS[table] ?? []);
  const out: Record<string, unknown> = {};
  for (const field of FIELDS[table]!) {
    const value = wire[field] ?? null;
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
      // ONE batched add per table: a many-row chain appended row by row would
      // be that many dataset versions of pure setup.
      const columns: Record<string, unknown[]> = {};
      for (const row of step.rows) {
        const built = physical(step.table, row);
        for (const field of FIELDS[step.table]!) (columns[field] ??= []).push(built[field]);
      }
      await handle.add(tableFromArrays(columns as never) as never);
      results.push({
        op: step.op, table: step.table, added: step.rows.length, version: await handle.version(),
      });
      continue;
    }

    if (step.op === "evidence") {
      // Namespace access, not a named import: the export does not exist yet and
      // a named import would be a link error breaking typecheck rather than a
      // runtime absence the parent already gates on.
      const open = (service as unknown as Record<string, unknown>).openEvidenceWriter as
        | ((root: string, options: unknown) => Promise<unknown>)
        | undefined;
      if (typeof open !== "function") {
        throw new Error("openEvidenceWriter absent from publication/service");
      }
      const writer = await open(plan.datasetRoot, {
        sourceNamespace: step.sourceNamespace,
        // Required by the existing options even though evidence reconciliation
        // allocates nothing. Throwing proves it: §1 says all values derive from
        // retained snapshots, so a call here is a contract violation, not a
        // detail to tolerate.
        newRevisionId: () => {
          throw new Error("evidence reconciliation must not allocate a revision id");
        },
      });
      const actions: unknown[] = [];
      try {
        for (const action of step.actions) {
          const facade = (writer as Record<string, Record<string, unknown>>).evidence;
          const method = facade[action.method] as (bytes: Uint8Array) => Promise<unknown>;
          const bytes = new TextEncoder().encode(JSON.stringify(action.request));
          try {
            actions.push({ method: action.method, ok: true, result: await method(bytes) });
          } catch (error) {
            // Both the constructor name and the envelope, so the parent can
            // assert all four fields on an actually thrown instance.
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
