/**
 * Slice VA -- the v3-compat acceptance harness (#31 legacy adapters).
 *
 * docs/overnight/V3-PARITY.md §8: "One ordered script of real-shaped v3
 * calls... runs against v4 over POST /mcp/:bank with a bearer from a 0600
 * policy file on a fresh mktemp dataset."
 *
 * Written FIRST, before any adapter code exists (`docs/overnight/DECISIONS.md`
 * R18, D10: `ARRA_MCP_V3_COMPAT` stays off until this file is green). Every
 * step below is expected to be RED today: no `oracle_*` tool is wired into
 * `auth/service.ts`'s `TOOL_ACTION` map yet, so `tools/list` never advertises
 * one and every `tools/call` on one comes back `403 {error:"forbidden"}`,
 * identical to calling an unknown tool. That IS the assertion for V0 slice 2
 * (`docs/overnight/V3-PARITY.md` §7 "Failing-first tests per slice", V0#2) --
 * this file does not special-case it away.
 *
 * The session script (`test/fixtures/v3-compat-v1/sessions/v3-session-01.json`)
 * and the per-tool output shapes (`test/fixtures/v3-compat-v1/shapes/*.json`)
 * are both real: every argument shape is copied from a real
 * `mcp__arra-oracle__*` / `mcp__oracle-v2__*` tool_use call recorded on this
 * machine (see each step's `provenance`), and every v3 output shape cites its
 * `arra-oracle-v3` source file:line at commit `61e5f8b6`.
 *
 * The real app is started in-process (`buildApp`, same as `test/mcp-correctness.test.ts`)
 * against a REAL fresh target19 dataset (`createFixture`, the same Python
 * exporter every other kernel's tests use) and a REAL 0600 policy file with
 * three principals (`rw`, `ro`, `other`) matching V3-PARITY.md §8. Every HTTP
 * call below goes through `app.handle()` -> the real Elysia routes -> the real
 * `POST /mcp/:bank` handler -- never a shortcut around admission or dispatch.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import {
  FIXTURES_DIR,
  loadSession,
  loadShape,
  matchesShape,
  PRIMARY_KEY,
  type ShapeField,
  type Step,
} from "./helpers/v3-compat-shapes";

const session = loadSession();

// ─── real app + real dataset ─────────────────────────────────────────────

const HOST = "127.0.0.1:3939";
const ORIGIN = `http://${HOST}`;
const BANK: Record<Step["as"], string> = { rw: "bank-a", ro: "bank-a", other: "bank-b" };
const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

let fixture: Fixture;
let dataDir: string;
let policyPath: string;
let app: { handle(request: Request): Promise<Response> };
const tokenOf: Record<Step["as"], string> = { rw: "", ro: "", other: "" };

let originalEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "ARRA_AUTH_POLICY",
  "ARRA_DATA_DIR",
  "ARRA_KNOWLEDGE_DATASET_ROOT",
  "ARRA_MCP_V3_COMPAT",
  "ARRA_ORIGIN",
  "PORT",
] as const;

/** nanoid21-shaped, deterministic. */
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

  // A REAL fresh target19 dataset -- the same Python exporter every other
  // kernel's tests use (helpers/publication-fixture.ts), seeded with the two
  // banks V3-PARITY.md §8 names.
  fixture = await createFixture(["bank-a", "bank-b"]);
  dataDir = await mkdtemp(join(tmpdir(), "arra-v3-compat-legacy-"));

  (["rw", "ro", "other"] as const).forEach((who) => {
    tokenOf[who] = randomBytes(32).toString("hex");
  });
  const sha256 = (secret: string) => createHash("sha256").update(secret, "ascii").digest("hex");

  policyPath = join(dataDir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        { id: "rw", disabled: false, workspaces: [{ name: "bank-a", actions: ["content:read", "content:write"] }], global_actions: [] },
        { id: "ro", disabled: false, workspaces: [{ name: "bank-a", actions: ["content:read"] }], global_actions: [] },
        { id: "other", disabled: false, workspaces: [{ name: "bank-b", actions: ["content:read", "content:write"] }], global_actions: [] },
      ],
      credentials: (["rw", "ro", "other"] as const).map((who) => ({
        id: `cred-${who}`,
        principal_id: who,
        sha256: sha256(tokenOf[who]),
        not_before: NOT_BEFORE,
        expires_at: EXPIRES_AT,
        revoked: false,
      })),
    }),
    { encoding: "utf-8", mode: 0o600 },
  );

  process.env.ARRA_AUTH_POLICY = policyPath;
  // The legacy memory dataset is never touched by any step in this session
  // (no `remember`/`recall`/... tool is called) -- `buildApp` (unlike
  // `startup`) does not require a pre-existing `memories` table, only a
  // resolvable directory for `storage.ts`'s module-level path read.
  process.env.ARRA_DATA_DIR = dataDir;
  process.env.ARRA_KNOWLEDGE_DATASET_ROOT = fixture.datasetRoot;
  // Family flag (R18 D10). Inert today: no composition module reads it yet.
  // Set anyway so the moment V0 lands and reads it, this harness needs no edit.
  process.env.ARRA_MCP_V3_COMPAT = "1";
  process.env.ARRA_ORIGIN = ORIGIN;
  process.env.PORT = "3939";

  const { buildApp } = await import("../src/index");
  const built = await buildApp({ policyPath, origin: ORIGIN });
  app = {
    handle(request: Request) {
      const headers = new Headers(request.headers);
      headers.set("host", HOST);
      const url = new URL(request.url);
      const rebased = new URL(url.pathname + url.search, ORIGIN);
      return built.handle(
        new Request(rebased, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          // @ts-expect-error duplex is required when streaming a body in Bun
          duplex: "half",
        }),
      );
    },
  };
}, 60_000);

afterAll(async () => {
  // `mcp/index.ts`'s `knowledgeAccess` is a module-level singleton -- must be
  // cleared so a later test file in the same process does not inherit this
  // fixture's (about to be deleted) dataset root.
  const { configureKnowledgeAccess } = await import("../src/mcp");
  configureKnowledgeAccess(null);
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await fixture?.cleanup();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 30_000);

// ─── wire helpers ─────────────────────────────────────────────────────────

let nextId = 1;

async function rawMcp(
  as: Step["as"],
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const request = new Request(`${ORIGIN}/mcp/${BANK[as]}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${tokenOf[as]}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const response = await app.handle(request);
  const status = response.status;
  let json: any = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status, json };
}

const toolsList = (as: Step["as"]) => rawMcp(as, { jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} });

const toolsCall = (as: Step["as"], tool: string, args: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
  rawMcp(as, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: tool, arguments: args } }, extraHeaders);

function listedNames(res: { json: any }): string[] {
  const tools = res.json?.result?.tools;
  return Array.isArray(tools) ? tools.map((t: any) => t?.name).filter((n: unknown): n is string => typeof n === "string") : [];
}

/** MCP tool results are content blocks (`mcp/protocol.ts:text`): a structured
 *  value comes back as a JSON string, `oracle_recap`/`____IMPORTANT`/a plain
 *  Error message come back as the raw string. Falls back to the raw string
 *  when it does not parse as JSON, never throws. */
function contentValue(res: { json: any }): unknown {
  const text = res.json?.result?.content?.[0]?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isToolError(res: { json: any }): boolean {
  return res.json?.result?.isError === true;
}

// ─── $ref resolution across steps ────────────────────────────────────────

const captured: Record<string, unknown> = {};
const stepValues: Record<number, unknown> = {};

function resolveArgs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(resolveArgs);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === "string" && Object.keys(obj).length === 1) {
      const key = obj.$ref;
      // A missing capture means the step that should have produced it already
      // failed (expected today -- see the file header). A placeholder keeps
      // THIS step independently runnable rather than throwing before its own
      // assertions -- which fail for the same underlying reason anyway.
      return key in captured ? captured[key] : `__unresolved_ref__:${key}`;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolveArgs(v);
    return out;
  }
  return value;
}

// ─── the gated-session.ts child, exercised for real ──────────────────────

describe("gated-session.ts: the v3-compat-v1 family's shared writer child", () => {
  test("plants a real node in bank-b through the real gate, for the cross-tenant checks below", async () => {
    const CHILD = join(FIXTURES_DIR, "core", "gated-session.ts");
    const nodeId = pad("v3vaseed1");
    const seeded = fixture.workspaces["bank-b"];
    expect(seeded, "createFixture must have seeded bank-b").toBeDefined();

    const content = revisionEnvelope("bank-b", seeded!, nodeId, {
      title: "bank-b baseline (never visible from bank-a)",
      body: "planted by test/fixtures/v3-compat-v1/core/gated-session.ts for slice VA's isolation steps",
    });
    // `publishRevision`'s outer envelope is `{operation_id, content}`
    // (`service.publishRevision.ts:29-30`) -- `revisionEnvelope` builds only
    // the inner `content`, matching every other publication test's own call.
    const request = { operation_id: "v3-compat-va:seed:bank-b:1", content };
    const result = await runGated(fixture.datasetRoot, CHILD, [
      fixture.datasetRoot,
      JSON.stringify({ ops: [{ facade: "publication", method: "publishRevision", request }] }),
    ]);
    if (result.code !== 0) throw new Error(`gated-session.ts exited ${result.code}: ${result.stderr.slice(0, 700)}`);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) throw new Error(`no output from gated-session.ts: ${result.stderr.slice(0, 700)}`);
    const parsed = JSON.parse(line);

    expect(parsed.op0.ok, JSON.stringify(parsed.op0)).toBe(true);
    expect(parsed.op0.value.outcome).toBe("accepted");
    expect(parsed.op0.value.node_id).toBe(nodeId);
  }, 60_000);
});

// ─── the acceptance session itself, step by step ─────────────────────────

describe("v3 client session over the real wire (test/fixtures/v3-compat-v1/sessions/v3-session-01.json)", () => {
  for (const step of session.steps) {
    const title = `step ${step.step} [${step.slice}] as ${step.as}${step.tool ? ` -- ${step.tool}` : ` -- ${step.method}`}`;

    test(title, async () => {
      const a = step.assert;

      if (a.kind === "tools_list_gate") {
        const res = await toolsList(step.as);
        expect(res.status).toBe(200);
        const names = listedNames(res);
        for (const name of a.expectListed ?? []) {
          expect(names, a.notes).toContain(name);
        }
        for (const name of a.expectAbsent ?? []) {
          expect(names, `${name} must never be advertised (${a.notes})`).not.toContain(name);
        }
        return;
      }

      if (a.kind === "not_listed_403") {
        const list = await toolsList(step.as);
        expect(listedNames(list), a.notes).not.toContain(step.tool);

        const spawnCalls: unknown[] = [];
        const originalSpawn = Bun.spawn;
        const originalSpawnSync = Bun.spawnSync;
        if (a.assertNoSpawn) {
          Bun.spawn = (...args: unknown[]) => {
            spawnCalls.push(args);
            throw new Error("test spy: Bun.spawn must not be called for a not-carried tool");
          };
          Bun.spawnSync = (...args: unknown[]) => {
            spawnCalls.push(args);
            throw new Error("test spy: Bun.spawnSync must not be called for a not-carried tool");
          };
        }
        try {
          const call = await toolsCall(step.as, step.tool!, resolveArgs(step.arguments ?? {}) as Record<string, unknown>);
          expect(call.status, a.notes).toBe(403);
          expect(call.json).toEqual({ error: "forbidden" });
          if (a.compareToUnknownTool) {
            const unknown = await toolsCall(step.as, a.compareToUnknownTool, {});
            expect(unknown.status).toBe(403);
            expect(call.json).toEqual(unknown.json);
          }
          if (a.assertNoSpawn) expect(spawnCalls).toEqual([]);
        } finally {
          Bun.spawn = originalSpawn;
          Bun.spawnSync = originalSpawnSync;
        }
        return;
      }

      const args = resolveArgs(step.arguments ?? {}) as Record<string, unknown>;
      const headers: Record<string, string> = step.peer ? { "x-arra-peer": step.peer } : {};

      if (a.kind === "alias_matches") {
        const list = await toolsList(step.as);
        if (a.neverListed) expect(listedNames(list), a.notes).not.toContain(step.tool);
        const call = await toolsCall(step.as, step.tool!, args, headers);
        expect(call.status, a.notes).toBe(200);
        expect(isToolError(call)).toBe(false);
        const value = contentValue(call) as { results?: unknown } | undefined;
        const prior = stepValues[a.compareToStep!] as { results?: unknown } | undefined;
        expect(value?.results, a.notes).toEqual(prior?.results);
        return;
      }

      if (a.kind === "isError_code") {
        const call = await toolsCall(step.as, step.tool!, args, headers);
        expect(call.status, a.notes).toBe(200);
        expect(isToolError(call), a.notes).toBe(true);
        const value = contentValue(call) as { compat?: { code?: string } } | undefined;
        expect(value?.compat?.code, a.notes).toBe(a.errorCode);
        return;
      }

      if (a.kind === "isError_generic") {
        const call = await toolsCall(step.as, step.tool!, args, headers);
        expect(call.status, a.notes).toBe(200);
        expect(isToolError(call), a.notes).toBe(true);
        return;
      }

      // "listed_and_ok"
      const list = await toolsList(step.as);
      expect(listedNames(list), `tools/list must include ${step.tool} once its slice lands -- ${a.notes}`).toContain(step.tool!);

      const call = await toolsCall(step.as, step.tool!, args, headers);
      expect(call.status, a.notes).toBe(200);
      expect(isToolError(call), a.notes).toBe(false);

      const value = contentValue(call) as Record<string, unknown> | string | undefined;
      stepValues[step.step] = value;

      if (a.shape === "guide") {
        expect(typeof value).toBe("string");
        const guide = loadShape("guide") as { v4Requirements: { mustMention: string[] } };
        for (const phrase of guide.v4Requirements.mustMention) {
          expect((value as string).toLowerCase(), a.notes).toContain(phrase.toLowerCase());
        }
      } else if (a.shape) {
        const shapeDef = loadShape(a.shape) as Record<string, Record<string, ShapeField>>;
        const key = PRIMARY_KEY[a.shape];
        const errors = matchesShape(value, shapeDef[key]!);
        expect(errors, `${a.shape}.${key} mismatch: ${errors.join("; ")}`).toEqual([]);
      }

      const obj = value as Record<string, unknown> | undefined;

      if (a.expectStringField) expect(typeof obj?.[a.expectStringField], a.notes).toBe("string");
      if (a.expectMessageCount !== undefined) {
        expect((obj?.messages as unknown[] | undefined)?.length, a.notes).toBe(a.expectMessageCount);
      }
      if (a.expectMinTotalDocuments !== undefined) {
        expect(obj?.total_documents as number | undefined, a.notes).toBeGreaterThanOrEqual(a.expectMinTotalDocuments);
      }
      if (a.expectEmptyResults) {
        expect(obj?.results ?? [], a.notes).toEqual([]);
      }
      if (a.expectFieldsPresent) {
        for (const field of a.expectFieldsPresent) expect(obj?.[field], `${field}: ${a.notes}`).not.toBeUndefined();
      }
      if (a.expectFields) {
        for (const [field, expected] of Object.entries(a.expectFields)) expect(obj?.[field], `${field}: ${a.notes}`).toEqual(expected);
      }
      if (a.expectSummary) {
        const summary = obj?.summary as Record<string, unknown> | undefined;
        for (const [field, expected] of Object.entries(a.expectSummary)) expect(summary?.[field], `summary.${field}: ${a.notes}`).toEqual(expected);
      }
      if (a.metadataEquals) {
        const metadata = obj?.metadata as Record<string, unknown> | undefined;
        for (const [field, expected] of Object.entries(a.metadataEquals)) expect(metadata?.[field], `metadata.${field}: ${a.notes}`).toEqual(expected);
      }
      const idOf = (row: unknown): unknown => (row as { id?: unknown })?.id;
      if (a.firstResultIsCaptured) {
        const results = obj?.results as unknown[] | undefined;
        expect(idOf(results?.[0]), a.notes).toBe(captured[a.firstResultIsCaptured]);
      }
      if (a.firstFileIsCaptured) {
        const files = obj?.files as unknown[] | undefined;
        const filename = (files?.[0] as { filename?: unknown })?.filename;
        expect(filename, a.notes).toBe(captured[a.firstFileIsCaptured]);
      }
      if (a.includesCaptured) {
        const rows = (obj?.documents ?? obj?.traces ?? obj?.results) as unknown[] | undefined;
        const ids = new Set((rows ?? []).map(idOf));
        for (const name of a.includesCaptured) expect(ids.has(captured[name]), `${name}: ${a.notes}`).toBe(true);
      }
      if (a.excludesCaptured) {
        const rows = obj?.results as unknown[] | undefined;
        const ids = new Set((rows ?? []).map(idOf));
        for (const name of a.excludesCaptured) expect(ids.has(captured[name]), `${name}: ${a.notes}`).toBe(false);
      }

      if (step.capture) {
        captured[step.capture.as] = obj?.[step.capture.path];
      }
    });
  }
});
