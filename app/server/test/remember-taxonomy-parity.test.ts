// D5a fix round (Opus-verified findings on v4/on-remember-taxonomy): three
// gaps the unit-level `mcp-remember-taxonomy.test.ts` could not see because it
// fakes `KnowledgeAccess` --
//
//  1. `remember` must NOT fail every call once a real (but unconfigured, no
//     `ARRA_KNOWLEDGE_DATASET_ROOT`) `KnowledgeAccess` is wired -- that
//     deployment shape is documented as still-working in `composition.ts`.
//  2. `remember` MUST refuse an invented `type` when a real taxonomy dataset
//     IS configured, through the REAL `buildApp` wiring end to end (no fake).
//  3. HTTP `POST /api/memories` -- audited as MCP `remember` per #31 --
//     enforces the SAME refusal as the MCP tool, not a free-text bypass.
//
// Real `buildApp`, real fixture-seeded taxonomy dataset, real legacy `memories`
// table. No fake KnowledgeAccess. ONE shared `ARRA_DATA_DIR`/legacy store for
// the whole file: `src/db.ts` caches its LanceDB connection/table at module
// scope for the process, so two different data directories inside one test
// file collide with that cache once the first directory is removed -- this
// file therefore only ever toggles `ARRA_KNOWLEDGE_DATASET_ROOT`, never
// `ARRA_DATA_DIR`, between its two scenarios.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { connect } from "@lancedb/lancedb";
import { Bool, Field, FixedSizeList, Float32, Int64, Schema, TimestampMillisecond, Utf8 } from "apache-arrow";
import { createFixture, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const ORIGIN = "http://127.0.0.1:3939";
const ALPHA = "alpha-workspace";
const TOKEN = "7".repeat(64);
const AUTH = `Bearer ${TOKEN}`;

// The legacy `memories` table `remember`/`insertMemory` writes into -- same
// schema `mcp-correctness.test.ts` builds by hand, since this suite's claim
// is about taxonomy validation, not the memories store itself.
const utf8 = (name: string, nullable = true) => new Field(name, new Utf8(), nullable);
const int64 = (name: string, nullable = false) => new Field(name, new Int64(), nullable);
const MEMORY_SCHEMA = new Schema([
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

let dir: string;
let policyPath: string;
let dataDir: string;
let fixture: Fixture;
let originalDataDir: string | undefined;
let originalRoot: string | undefined;

async function withRoot<T>(root: string | undefined, run: () => Promise<T>): Promise<T> {
  if (root === undefined) delete process.env.ARRA_KNOWLEDGE_DATASET_ROOT;
  else process.env.ARRA_KNOWLEDGE_DATASET_ROOT = root;
  return run();
}

async function callTool(built: { handle(r: Request): Promise<Response> }, type: string): Promise<any> {
  const res = await built.handle(
    new Request(`${ORIGIN}/mcp/${ALPHA}`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json", host: "127.0.0.1:3939" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "remember", arguments: { content: "hello", type } },
      }),
    }),
  );
  return res.json();
}

async function postMemory(built: { handle(r: Request): Promise<Response> }, name: string, type: string): Promise<Response> {
  return built.handle(
    new Request(`${ORIGIN}/api/memories?workspace_name=${ALPHA}`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json", host: "127.0.0.1:3939" },
      body: JSON.stringify({ workspace_name: ALPHA, name, content: "hello", type }),
    }),
  );
}

beforeAll(async () => {
  fixture = await createFixture([ALPHA]);
  dir = await mkdtemp(join(tmpdir(), "arra-remember-parity-"));
  policyPath = join(dir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [{ id: "writer", disabled: false, workspaces: [{ name: ALPHA, actions: ["content:read", "content:write"] }], global_actions: [] }],
      credentials: [
        {
          id: "cred-writer",
          principal_id: "writer",
          sha256: createHash("sha256").update(TOKEN, "ascii").digest("hex"),
          not_before: "2020-01-01T00:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  dataDir = join(dir, "legacy-data");
  const conn = await connect(dataDir);
  await conn.createEmptyTable("memories", MEMORY_SCHEMA);
  originalDataDir = process.env.ARRA_DATA_DIR;
  originalRoot = process.env.ARRA_KNOWLEDGE_DATASET_ROOT;
  process.env.ARRA_DATA_DIR = dataDir;
}, testTimeout(60_000));

afterAll(async () => {
  if (originalDataDir === undefined) delete process.env.ARRA_DATA_DIR;
  else process.env.ARRA_DATA_DIR = originalDataDir;
  if (originalRoot === undefined) delete process.env.ARRA_KNOWLEDGE_DATASET_ROOT;
  else process.env.ARRA_KNOWLEDGE_DATASET_ROOT = originalRoot;
  await fixture?.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe("remember taxonomy parity (real wiring, fix round)", () => {
  test("no ARRA_KNOWLEDGE_DATASET_ROOT: MCP remember with any type still succeeds (legacy-store-only deployment)", async () => {
    await withRoot(undefined, async () => {
      const { buildApp } = await import("../src/index");
      const built = await buildApp({ policyPath, origin: ORIGIN });
      const body = await callTool(built, "whatever_invented");
      expect(body.result?.isError).not.toBe(true);
    });
  }, testTimeout(30_000));

  test("ARRA_KNOWLEDGE_DATASET_ROOT configured: MCP remember refuses an invented type with the closed taxonomy envelope", async () => {
    await withRoot(fixture.datasetRoot, async () => {
      const { buildApp } = await import("../src/index");
      const built = await buildApp({ policyPath, origin: ORIGIN });
      const body = await callTool(built, "invented_type");
      expect(body.result?.isError).toBe(true);
      const payload = JSON.parse(body.result.content[0].text);
      expect(payload).toMatchObject({ version: "arra-taxonomy-error/v1", code: "invalid_reference", path: "/type" });
    });
  }, testTimeout(30_000));

  test("ARRA_KNOWLEDGE_DATASET_ROOT configured: MCP remember accepts a seeded active type unchanged", async () => {
    await withRoot(fixture.datasetRoot, async () => {
      const { buildApp } = await import("../src/index");
      const built = await buildApp({ policyPath, origin: ORIGIN });
      const body = await callTool(built, "decision");
      expect(body.result?.isError).not.toBe(true);
    });
  }, testTimeout(30_000));

  test("ARRA_KNOWLEDGE_DATASET_ROOT configured: HTTP POST /api/memories refuses the SAME invented type, same closed envelope -- no parity split", async () => {
    await withRoot(fixture.datasetRoot, async () => {
      const { buildApp } = await import("../src/index");
      const built = await buildApp({ policyPath, origin: ORIGIN });
      const res = await postMemory(built, "n-refused", "invented_type");
      expect(res.status).toBe(400);
      const payload = await res.json();
      expect(payload).toMatchObject({ version: "arra-taxonomy-error/v1", code: "invalid_reference", path: "/type" });
    });
  }, testTimeout(30_000));

  test("ARRA_KNOWLEDGE_DATASET_ROOT configured: HTTP POST /api/memories accepts a seeded active type, golden shape unchanged", async () => {
    await withRoot(fixture.datasetRoot, async () => {
      const { buildApp } = await import("../src/index");
      const built = await buildApp({ policyPath, origin: ORIGIN });
      const res = await postMemory(built, "n-accepted", "note");
      expect(res.status).toBe(201);
      const payload = (await res.json()) as any;
      expect(Object.keys(payload).sort()).toEqual(["embedded", "id"]);
    });
  }, testTimeout(30_000));
});
