// The one place the `instance_audit` connection is opened (#31 maint-audit,
// Nat 2026-09-28 D4b).
//
// `POST /api/backfill` and `POST /api/reindex` admit a GLOBAL action — no
// workspace, and `mcp_calls.workspace_name` is NOT NULL, so neither route can
// write a row there without a sentinel workspace, which D4b forbids. This is
// a SEPARATE table at the same server data root (`DATA_DIR`, `../storage.ts`)
// that `mcp_calls` already lives at — a dedicated Lance dataset, not a
// workspace one, matching the existing idiom (`mcp/calls.openCallLogTable.ts`)
// rather than introducing a new storage mechanism (JSONL) for one audit sink.
//
// Fix-round 2 (verifier-confirmed, reproduced standalone): `createTable(TABLE,
// [sample])` infers the Arrow schema from the FIRST row it ever sees. A
// REFUSED call's row has `principal_id: null` — if a refusal is the first
// call the instance ever sees (exactly the shape of an anonymous prober,
// which is the live probe's own order), Lance cannot infer a type for an
// all-null column and throws `Failed to infer data type for field ... at row
// 0`, and that throw was only ever visible as `instanceAuditFailureCount()`
// ticking up — the very row a security review most needs was silently
// dropped. The fix is an EXPLICIT schema, never inferred from data, exactly
// like `mcp-correctness.test.ts`'s `callSchema` — the canonical column list
// is declared in Python (`migrate-py/src/arra_migrate/models/
// instance_audit.py`; AGENTS.md: Python declares the schema, TS never does),
// and mirrored here by hand because this table is intentionally OUTSIDE the
// tenant `TABLES` registry `python -m arra_migrate` creates (it is
// instance-level, not per-workspace) — nothing here overrides that model, it
// only supplies the same shape to `createEmptyTable`.

import { connect, type Table } from "@lancedb/lancedb";
import { Field, Int64, Schema, Utf8 } from "apache-arrow";
import { DATA_DIR, storageOptions } from "../storage";

const TABLE = "instance_audit";

// Mirrors `arra_migrate.models.instance_audit.InstanceAudit` field-for-field.
const utf8 = (name: string, nullable = true) => new Field(name, new Utf8(), nullable);
const int64 = (name: string) => new Field(name, new Int64(), false);
const INSTANCE_AUDIT_SCHEMA = new Schema([
  utf8("id", false),
  utf8("principal_id"), // nullable: NULL on every refusal
  utf8("route", false),
  utf8("action", false),
  utf8("outcome", false),
  utf8("status", false),
  utf8("input_summary", false),
  int64("started_at"),
  int64("finished_at"),
  int64("duration_ms"),
  utf8("request_id", false),
]);

let handle: Awaited<ReturnType<typeof connect>> | null = null;

export async function openInstanceAuditTable(): Promise<Table> {
  handle ??= await connect(DATA_DIR, { storageOptions: storageOptions() });
  const names = await handle.tableNames();
  if (names.includes(TABLE)) return handle.openTable(TABLE);
  return handle.createEmptyTable(TABLE, INSTANCE_AUDIT_SCHEMA);
}
