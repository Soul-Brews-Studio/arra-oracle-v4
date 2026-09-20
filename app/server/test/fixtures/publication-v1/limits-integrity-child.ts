/**
 * Owned gated child for the #26 limits / ancestry-integrity evidence.
 *
 * `exec_with_gate` replaces a Python launcher with THIS program, so by the
 * time it runs it already holds the writer gate on the dataset and fd 42 is
 * inherited. Everything it does is therefore a legitimate gated write, not a
 * bypass — the whole point of contract §3 is that every writer takes the same
 * gate first.
 *
 * It is a DUMB EXECUTOR on purpose. The test decides every identifier, body,
 * timestamp and ordinal and hands them over as a plan; this file converts wire
 * values to physical ones, computes real canonical digests with the protected
 * codec, and writes. Keeping the decisions in the test is what lets the test
 * compute its expected byte budget independently of anything here.
 *
 * Two roles are deliberately separated and should not be confused when reading
 * a failure:
 *
 *   PREPARATION — `seedRevisions`, `seedNode`, `rawUpdate`. Disposable state
 *   built under the gate. None of it is an assertion about the kernel; it is
 *   how a 1024-row chain or a corrupt ancestor gets onto disk at all, since
 *   the kernel offers no API that would produce one.
 *
 *   ASSERTED BEHAVIOUR — `publish`. This calls the real
 *   `openPublicationWriter` and reports exactly what the kernel returned or
 *   threw. Nothing here interprets it.
 */

import { readFileSync } from "node:fs";
import { connect } from "@lancedb/lancedb";
import { tableFromArrays } from "apache-arrow";
import { revisionOp } from "../../../src/contracts/revision-v1";
import { PublicationError } from "../../../src/publication/errors";
import { REVISION_FIELDS, timestampToMicros } from "../../../src/publication/rows";
import { openPublicationWriter } from "../../../src/publication/service";

/** The 21 governed envelope keys, in the order the codec expects them. */
const ENVELOPE_KEYS = [
  "workspace_name", "node_id", "base_revision_id",
  "title", "body", "body_format", "fields",
  "author_peer_name", "observer_peer_name", "subject_peer_name", "session_name",
  "is_active", "valid_from", "valid_to", "change_reason",
  "schema_version", "canonical_version",
  "term_snapshot_json", "link_snapshot_json",
  "h_metadata", "internal_metadata",
] as const;

type WireRow = Record<string, unknown>;

type Step =
  | { op: "seedRevisions"; rows: WireRow[] }
  | { op: "seedNode"; node: Record<string, unknown> }
  | { op: "rawUpdate"; table: string; predicate: string; assignments: Record<string, string> }
  | { op: "publish"; envelope: Record<string, unknown>; revisionId: string; createdAtMs: number; bodyPad?: number }
  | { op: "snapshot" };

type Plan = { datasetRoot: string; steps: Step[] };

const INT64_FIELDS = new Set(["revision_no", "schema_version"]);
const TIMESTAMP_FIELDS = new Set(["valid_from", "valid_to", "created_at"]);

/**
 * Turn one wire row into the physical row the SDK stores.
 *
 * The digest is computed here, by the protected codec, from the row's own 21
 * envelope keys — so a seeded chain carries REAL canonical digests and the
 * kernel's recompute-on-read has something honest to verify. A hand-written
 * digest would make every integrity test vacuous.
 */
function toPhysicalRevision(input: WireRow): Record<string, unknown> {
  // `body_pad` keeps a 16 MiB plan file small: the test sends a padding COUNT
  // and both sides expand it the same way. 'a' is one UTF-8 byte and is never
  // escaped by JSON.stringify, so one pad unit is exactly one wire byte --
  // which is what makes the test's byte arithmetic expressible without
  // materialising the strings.
  const pad = typeof input.body_pad === "number" ? input.body_pad : 0;
  const wire: WireRow = { ...input, body: `${String(input.body ?? "b")}${"a".repeat(pad)}` };
  delete wire.body_pad;

  const envelope = new Map<string, unknown>();
  for (const key of ENVELOPE_KEYS) envelope.set(key, wire[key] ?? null);
  const validated = revisionOp(envelope as never, []);

  const columns = validated.columns as unknown as Record<string, unknown>;
  const source: Record<string, unknown> = {
    ...wire,
    content_digest: validated.content_digest,
    fields: columns.fields,
    term_snapshot_json: columns.term_snapshot_json,
    link_snapshot_json: columns.link_snapshot_json,
    h_metadata: columns.h_metadata ?? null,
    internal_metadata: columns.internal_metadata ?? null,
  };

  const physical: Record<string, unknown> = {};
  for (const field of REVISION_FIELDS) {
    const value = source[field] ?? null;
    if (INT64_FIELDS.has(field)) {
      physical[field] = BigInt(value as string);
    } else if (TIMESTAMP_FIELDS.has(field)) {
      // BigInt microseconds, never a Date and never a JS number: measured,
      // a number here is accepted and silently corrupts the stored value.
      physical[field] = value === null ? null : timestampToMicros(value);
    } else {
      physical[field] = value;
    }
  }
  return physical;
}

function toPhysicalNode(node: Record<string, unknown>): Record<string, unknown> {
  return {
    id: node.id,
    workspace_name: node.workspace_name,
    current_revision_id: node.current_revision_id ?? null,
    created_at: timestampToMicros(node.created_at),
    updated_at: timestampToMicros(node.updated_at),
  };
}

async function main(): Promise<number> {
  const plan = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Plan;
  const connection = await connect(plan.datasetRoot, { readConsistencyInterval: 0 });
  const results: unknown[] = [];

  for (const step of plan.steps) {
    switch (step.op) {
      case "seedRevisions": {
        const table = await connection.openTable("node_revisions");
        // ONE batched add for the whole chain. A 1024-row chain built one
        // append at a time would be 1024 dataset versions of pure setup.
        const columns: Record<string, unknown[]> = {};
        for (const wire of step.rows) {
          const physical = toPhysicalRevision(wire);
          for (const key of REVISION_FIELDS) (columns[key] ??= []).push(physical[key]);
        }
        await table.add(tableFromArrays(columns as never) as never);
        results.push({ op: step.op, added: step.rows.length, version: await table.version() });
        break;
      }
      case "seedNode": {
        const table = await connection.openTable("nodes");
        const physical = toPhysicalNode(step.node);
        const columns: Record<string, unknown[]> = {};
        for (const [key, value] of Object.entries(physical)) columns[key] = [value];
        await table.add(tableFromArrays(columns as never) as never);
        results.push({ op: step.op, version: await table.version() });
        break;
      }
      case "rawUpdate": {
        // Deliberate corruption of DISPOSABLE fixture state. The kernel has no
        // API that produces a cyclic or digest-stale ancestor, so the only way
        // to prove it rejects one is to write one here.
        const table = await connection.openTable(step.table);
        await table.checkoutLatest();
        const result = (await table.update(step.assignments, { where: step.predicate })) as unknown as {
          rowsUpdated?: number;
        };
        results.push({ op: step.op, rowsUpdated: result?.rowsUpdated ?? 0, version: await table.version() });
        break;
      }
      case "publish": {
        // The asserted behaviour. Real factory, real gate, real codec.
        // Same pad expansion as the seeded rows, for the same reason.
        const content = step.envelope.content as Record<string, unknown>;
        if (typeof step.bodyPad === "number") {
          content.body = `${String(content.body ?? "b")}${"a".repeat(step.bodyPad)}`;
        }
        const writer = await openPublicationWriter(plan.datasetRoot, {
          clock: () => step.createdAtMs,
          newRevisionId: () => step.revisionId,
        });
        try {
          const outcome = await writer.publishRevision(
            new TextEncoder().encode(JSON.stringify({ operation_id: step.envelope.operation_id, content })),
          );
          results.push({ op: step.op, ok: true, outcome });
        } catch (error) {
          results.push({
            op: step.op,
            ok: false,
            error:
              error instanceof PublicationError
                ? error.toJSON()
                : { version: "unknown", code: String((error as Error)?.message ?? error) },
          });
        } finally {
          await writer.close();
        }
        break;
      }
      case "snapshot": {
        const snapshot: Record<string, unknown> = {};
        for (const name of ["node_revisions", "nodes"]) {
          const table = await connection.openTable(name);
          await table.checkoutLatest();
          snapshot[name] = { version: await table.version(), rows: await table.countRows() };
        }
        results.push({ op: step.op, snapshot });
        break;
      }
    }
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
