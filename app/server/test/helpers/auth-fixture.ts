// Shared scratch fixtures for the #25 integration tests.
//
// Everything here is synthetic and temporary: a scratch LanceDB directory, a
// scratch policy file, and hand-made credentials. No real credential, no real
// dataset, no model call, no network. Digests were computed independently with
// Python hashlib and are re-derived in-test, so agreement is cross-checked
// rather than self-asserted.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Connection } from "@lancedb/lancedb";
import {
  Bool,
  Field,
  FixedSizeList,
  Float32,
  Int64,
  Schema,
  TimestampMillisecond,
  Utf8,
} from "apache-arrow";

const utf8 = (name: string, nullable = true) => new Field(name, new Utf8(), nullable);
const int64 = (name: string, nullable = false) => new Field(name, new Int64(), nullable);

export const memorySchema = new Schema([
  utf8("id", false), utf8("name", false), utf8("workspace_name", false),
  utf8("session_name"), utf8("peer_name"), utf8("subject_peer_name"), utf8("type", false),
  utf8("content", false),
  new Field("embedding", new FixedSizeList(384, new Field("item", new Float32(), true)), true),
  new Field("created_at", new TimestampMillisecond(), false),
  new Field("valid_from", new TimestampMillisecond(), true),
  new Field("valid_to", new TimestampMillisecond(), true),
  utf8("sync_state", false), new Field("last_sync_at", new TimestampMillisecond(), true),
  int64("sync_attempts"), utf8("superseded_by"),
  new Field("superseded_at", new TimestampMillisecond(), true),
  new Field("is_active", new Bool(), false), utf8("h_metadata"), utf8("internal_metadata"),
]);

export const callSchema = new Schema([
  utf8("id", false), utf8("workspace_name", false), utf8("session_name"), utf8("peer_name"),
  utf8("tool", false), utf8("status", false), int64("duration_ms"), utf8("h_metadata"),
  utf8("internal_metadata"), int64("created_at"),
]);

/** Synthetic credentials. Never real; digests independently computed. */
export const TOKENS = {
  alpha: {
    secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sha256: "a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e",
  },
  beta: {
    secret: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
    sha256: "7b9d07f2404b102b3c62fede026097c5ab81668f18414abd8ea560cecb008006",
  },
  maint: {
    secret: "deadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00d",
    sha256: "92f068d70e7e7c7cb67d71ea1454c258cf7c96fc071748ee7f3894622c1d9eaf",
  },
  unknown: {
    secret: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    sha256: "2a8abfa8cb9906290437854193ca6bca41d4d4e26d1d454bd66a35158095e737",
  },
} as const;

export const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
export const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
/** A fixed instant inside every window above; tests never read a real clock. */
export const NOW_MS = Date.parse("2026-09-20T12:00:00.000Z");

export const memoryRow = (id: string, bank: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  workspace_name: bank,
  session_name: null,
  peer_name: null,
  subject_peer_name: null,
  type: "note",
  content: `content ${id}`,
  embedding: null,
  created_at: new Date("2026-09-20T00:00:00.000Z"),
  valid_from: null,
  valid_to: null,
  sync_state: "pending",
  last_sync_at: null,
  sync_attempts: 0,
  superseded_by: null,
  superseded_at: null,
  is_active: true,
  h_metadata: null,
  internal_metadata: null,
  ...overrides,
});

export const callRow = (id: string, bank: string, createdAt: number, overrides: Record<string, unknown> = {}) => ({
  id,
  workspace_name: bank,
  session_name: null,
  peer_name: null,
  tool: "recall",
  status: "ok",
  duration_ms: 3,
  h_metadata: JSON.stringify({ input: "{}", result: "[]" }),
  internal_metadata: null,
  created_at: createdAt,
  ...overrides,
});

/**
 * A policy granting: operator-a all four actions on `alpha`; operator-b
 * content:read+write on `beta`; operator-m both global maintenance actions and
 * NO workspace at all (so it must fail workspace discovery).
 */
export const defaultPolicyDocument = () => ({
  version: "arra-auth/v1",
  principals: [
    {
      id: "operator-a",
      disabled: false,
      workspaces: [
        { name: "alpha", actions: ["content:read", "content:write", "audit:read", "diagnostics:read"] },
      ],
      global_actions: [],
    },
    {
      id: "operator-b",
      disabled: false,
      workspaces: [{ name: "beta", actions: ["content:read", "content:write"] }],
      global_actions: [],
    },
    {
      id: "operator-m",
      disabled: false,
      workspaces: [],
      global_actions: ["maintenance:backfill", "maintenance:reindex"],
    },
  ],
  credentials: [
    { id: "cred-a", principal_id: "operator-a", sha256: TOKENS.alpha.sha256, not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
    { id: "cred-b", principal_id: "operator-b", sha256: TOKENS.beta.sha256, not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
    { id: "cred-m", principal_id: "operator-m", sha256: TOKENS.maint.sha256, not_before: NOT_BEFORE, expires_at: EXPIRES_AT, revoked: false },
  ],
});

export type Scratch = {
  dataDir: string;
  policyPath: string;
  connection: Connection;
  writePolicy: (document: unknown) => Promise<void>;
  cleanup: () => Promise<void>;
};

/** Create a scratch dataset plus a scratch policy file. Caller must cleanup(). */
export async function createScratch(): Promise<Scratch> {
  const dataDir = await mkdtemp(join(tmpdir(), "arra-v4-auth-"));
  const policyPath = join(dataDir, "policy.json");
  const connection = await connect(dataDir);

  const memories = await connection.createEmptyTable("memories", memorySchema);
  await memories.add([
    memoryRow("alpha-one", "alpha"),
    memoryRow("alpha-two", "alpha"),
    memoryRow("beta-one", "beta"),
  ]);
  const callLog = await connection.createEmptyTable("mcp_calls", callSchema);
  await callLog.add([callRow("call-alpha", "alpha", 10), callRow("call-beta", "beta", 20)]);

  const writePolicy = async (document: unknown) => {
    await writeFile(policyPath, JSON.stringify(document), { encoding: "utf-8", mode: 0o600 });
  };
  await writePolicy(defaultPolicyDocument());

  return {
    dataDir,
    policyPath,
    connection,
    writePolicy,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

export const bearer = (secret: string) => `Bearer ${secret}`;

/**
 * Scratch store dependencies bound to ONE connection.
 *
 * Injected explicitly so the auth suites never touch `src/db`'s module-level
 * connection singleton. Without this, running several auth suites in one Bun
 * process made whichever file initialised first pin the data directory for all
 * the others — tests passed alone and failed together.
 */
export function createScratchDependencies(connection: Connection) {
  const memories = () => connection.openTable("memories");
  const callsTable = () => connection.openTable("mcp_calls");
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

  const clean = (rows: any[]) =>
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      workspace_name: r.workspace_name,
      session_name: r.session_name ?? null,
      peer_name: r.peer_name ?? null,
      subject_peer_name: r.subject_peer_name ?? null,
      type: r.type,
      content: r.content,
      sync_state: r.sync_state,
      is_active: Boolean(r.is_active),
      embedded: r.embedding != null,
    }));

  return {
    async insert(row: any) {
      const table = await memories();
      const id = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      await table.add([memoryRow(id, row.workspace_name, { name: row.name, content: row.content, type: row.type ?? "note" })]);
      return { id, embedded: false };
    },
    async list(bank: string, limit: number) {
      const table = await memories();
      await table.checkoutLatest();
      return clean(await table.query().where(`workspace_name = ${quote(bank)}`).limit(limit).toArray());
    },
    async searchText(q: string, bank: string, limit: number) {
      const table = await memories();
      await table.checkoutLatest();
      const rows = await table.query().where(`workspace_name = ${quote(bank)}`).limit(limit).toArray();
      return clean(rows.filter((r: any) => String(r.content).includes(q)));
    },
    async searchVector(_q: string, bank: string, limit: number) {
      const table = await memories();
      await table.checkoutLatest();
      return clean(await table.query().where(`workspace_name = ${quote(bank)}`).limit(limit).toArray());
    },
    async getById(bank: string, id: string) {
      const table = await memories();
      await table.checkoutLatest();
      const rows = await table.query().where(`workspace_name = ${quote(bank)} AND id = ${quote(id)}`).limit(1).toArray();
      return clean(rows)[0] ?? null;
    },
    async stats(bank: string) {
      const table = await memories();
      await table.checkoutLatest();
      const rows = await table.countRows(`workspace_name = ${quote(bank)}`);
      return { table: "memories", rows, embedded: 0, unembedded: rows };
    },
    async backfill(_batch: number) {
      return { embedded: 0, remaining: 0 };
    },
    async ensureFtsIndex(_replace?: boolean) {
      return ["scratch:none"];
    },
    async embedHealth() {
      // Never contacts a model: these suites must perform no model I/O at all.
      return { ok: false, model: "scratch", dims: 384, detail: "scratch fixture" };
    },
    async recentCalls(bank: string, limit: number, status?: string) {
      const table = await callsTable();
      await table.checkoutLatest();
      const predicates = [`workspace_name = ${quote(bank)}`];
      if (status) predicates.push(`status = ${quote(status)}`);
      const rows = await table.query().where(predicates.join(" AND ")).limit(limit).toArray();
      return rows.map((r: any) => ({ id: r.id, tool: r.tool, status: r.status }));
    },
    async aggregateCalls(bank: string) {
      const table = await callsTable();
      await table.checkoutLatest();
      const rows = await table.query().where(`workspace_name = ${quote(bank)}`).toArray();
      return { total: rows.length };
    },
    async logCall(record: Record<string, unknown>) {
      const table = await callsTable();
      const entry = record as any;
      await table.add([
        callRow(`c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, entry.workspace_name, Date.now(), {
          tool: entry.tool,
          status: entry.status,
          h_metadata: JSON.stringify({ input: "redacted", result: "redacted", auth: entry.auth }),
        }),
      ]);
    },
  };
}
