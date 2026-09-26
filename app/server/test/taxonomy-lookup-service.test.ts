// K2 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18): lookupVocabularyByName
// and lookupTermByName as content:read methods.
//
// The internals already existed (`service.lookupVocabularyByName.ts`,
// `service.lookupTermByName.ts`) but only create/rename/seed could reach
// them, so a caller holding a name -- the v3 adapter resolving `type`,
// `concepts` or a concept term -- had no way to find an id another writer
// (the UI, the migration) had already chosen. Written BEFORE the facade
// methods and registry entries existed.
//
// Kernel reads run against a REAL fixture dataset through the gateless
// reader; reachability runs the REAL createApp / createMcpAdapter over a REAL
// 0600 policy with a content:read-only credential. No gate, no writes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { createOperationService, type StoreDependencies } from "../src/auth/service";
import { KNOWLEDGE_METHODS } from "../src/knowledge/registry";
import { createKnowledgeAccess } from "../src/knowledge/transport";
import { configureKnowledgeAccess, createMcpAdapter } from "../src/mcp";
import { openEvidenceReader } from "../src/publication/service";
import { createFixture, type Fixture } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";

const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
const ORIGIN = "http://127.0.0.1:3939";
const READ_TOKEN = "9".repeat(64);
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

let fixture: Fixture;
let dir: string;
let policyPath: string;
let reader: Awaited<ReturnType<typeof openEvidenceReader>>;
type LookupReader = {
  lookupVocabularyByName(b: Uint8Array): Promise<Record<string, unknown> | null>;
  lookupTermByName(b: Uint8Array): Promise<Record<string, unknown> | null>;
};
const taxonomy = () => reader.taxonomy as unknown as LookupReader;

beforeAll(async () => {
  fixture = await createFixture([ALPHA, BETA]);
  reader = await openEvidenceReader(fixture.datasetRoot);
  dir = await mkdtemp(join(tmpdir(), "arra-k2-"));
  policyPath = join(dir, "policy.json");
  await writeFile(policyPath, JSON.stringify({
    version: "arra-auth/v1",
    principals: [{ id: "reader", disabled: false, workspaces: [{ name: ALPHA, actions: ["content:read"] }], global_actions: [] }],
    credentials: [{
      id: "cred-reader", principal_id: "reader", sha256: createHash("sha256").update(READ_TOKEN, "ascii").digest("hex"),
      not_before: "2020-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z", revoked: false,
    }],
  }), { encoding: "utf-8", mode: 0o600 });
}, testTimeout(60_000));

afterAll(async () => {
  configureKnowledgeAccess(null);
  await fixture?.cleanup();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("K2 kernel: by-name reads", () => {
  test("lookupVocabularyByName returns the seeded row, encoded like getVocabulary", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const row = await taxonomy().lookupVocabularyByName(bytes({ workspace_name: ALPHA, name: "type" }));
    expect(row?.id).toBe(seeded.vocabulary_ids.type);
    const byId = await reader.taxonomy.getVocabulary(bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type }));
    expect(row).toEqual(byId);
  });

  test("lookupTermByName returns the seeded term inside its vocabulary, encoded like getTerm", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    const note = seeded.term_ids.type.note;
    const row = await taxonomy().lookupTermByName(bytes({ workspace_name: ALPHA, vocabulary_id: note.vocabulary_id, name: note.name }));
    expect(row?.id).toBe(note.id);
    expect(row).toEqual(await reader.taxonomy.getTerm(bytes({ workspace_name: ALPHA, term_id: note.id })));
  });

  test("a miss is null, never an error", async () => {
    const seeded = fixture.workspaces[ALPHA]!;
    expect(await taxonomy().lookupVocabularyByName(bytes({ workspace_name: ALPHA, name: "no-such-vocabulary" }))).toBeNull();
    expect(await taxonomy().lookupTermByName(bytes({ workspace_name: ALPHA, vocabulary_id: seeded.vocabulary_ids.type, name: "no-such-term" }))).toBeNull();
  });

  test("names are exact: no trim, no case fold", async () => {
    for (const name of ["Type", " type", "type "]) {
      expect(await taxonomy().lookupVocabularyByName(bytes({ workspace_name: ALPHA, name }))).toBeNull();
    }
  });

  test("isolation: another workspace's rows are invisible", async () => {
    const alpha = fixture.workspaces[ALPHA]!;
    const beta = fixture.workspaces[BETA]!;
    const fromBeta = await taxonomy().lookupVocabularyByName(bytes({ workspace_name: BETA, name: "type" }));
    expect(fromBeta?.id).toBe(beta.vocabulary_ids.type);
    expect(fromBeta?.id).not.toBe(alpha.vocabulary_ids.type);
    const note = beta.term_ids.type.note;
    expect(await taxonomy().lookupTermByName(bytes({ workspace_name: ALPHA, vocabulary_id: note.vocabulary_id, name: note.name }))).toBeNull();
    expect(await taxonomy().lookupVocabularyByName(bytes({ workspace_name: "no-such-workspace", name: "type" }))).toBeNull();
  });

  test("closed keys and the name grammar are governed arra-error/v1 envelopes", async () => {
    const code = async (run: Promise<unknown>) => {
      try {
        await run;
      } catch (error) {
        const e = error as { toJSON?: () => { version: string; code: string; path: string } };
        return e.toJSON?.();
      }
      return "no error";
    };
    const vocab = (body: unknown) => code(taxonomy().lookupVocabularyByName(bytes(body)));
    const term = (body: unknown) => code(taxonomy().lookupTermByName(bytes(body)));
    const typeId = fixture.workspaces[ALPHA]!.vocabulary_ids.type;
    expect(await vocab({ workspace_name: ALPHA })).toMatchObject({ version: "arra-error/v1", code: "missing_field", path: "/name" });
    expect(await vocab({ workspace_name: ALPHA, name: "type", extra: 1 })).toMatchObject({ code: "unexpected_field", path: "/extra" });
    expect(await vocab({ workspace_name: ALPHA, name: "" })).toMatchObject({ code: "invalid_value", path: "/name" });
    expect(await vocab({ workspace_name: ALPHA, name: "x".repeat(257) })).toMatchObject({ code: "limit_exceeded", path: "/name" });
    expect(await vocab({ workspace_name: ALPHA, name: 7 })).toMatchObject({ code: "invalid_type", path: "/name" });
    expect(await term({ workspace_name: ALPHA, name: "note" })).toMatchObject({ code: "missing_field", path: "/vocabulary_id" });
    expect(await term({ workspace_name: ALPHA, vocabulary_id: "short", name: "note" })).toMatchObject({ path: "/vocabulary_id" });
    expect(await term({ workspace_name: ALPHA, vocabulary_id: typeId, name: "" })).toMatchObject({ code: "invalid_value", path: "/name" });
  });
});

describe("K2 transport: content:read on HTTP and MCP", () => {
  test("both methods are registry entries under content:read, scoped at the request root", () => {
    for (const method of ["lookupVocabularyByName", "lookupTermByName"]) {
      expect(KNOWLEDGE_METHODS[method]?.action).toBe("content:read");
      expect(KNOWLEDGE_METHODS[method]?.scopePath).toEqual([]);
    }
  });

  test("a content:read-only credential reaches both over HTTP and MCP, with the same answer", async () => {
    const access = createKnowledgeAccess({ datasetRoot: fixture.datasetRoot });
    configureKnowledgeAccess(access);
    const deps = { logCall: async () => {} } as unknown as StoreDependencies;
    const service = createOperationService({ policyPath }, deps);
    const app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), { knowledge: { policyPath, access } });
    const headers = { host: "127.0.0.1:3939", "content-type": "application/json", authorization: `Bearer ${READ_TOKEN}` };
    const note = fixture.workspaces[ALPHA]!.term_ids.type.note;
    const bodies = {
      lookupVocabularyByName: { workspace_name: ALPHA, name: "type" },
      lookupTermByName: { workspace_name: ALPHA, vocabulary_id: note.vocabulary_id, name: note.name },
    };
    const listed = await app.handle(new Request(`${ORIGIN}/mcp/${ALPHA}`, {
      method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));
    const names = ((await listed.json()) as any).result.tools.map((t: { name: string }) => t.name);
    for (const [method, body] of Object.entries(bodies)) {
      expect(names).toContain(`kb_${method}`);
      const http = await app.handle(new Request(`${ORIGIN}/api/knowledge/${ALPHA}/${method}`, { method: "POST", headers, body: JSON.stringify(body) }));
      expect(http.status).toBe(200);
      const httpBody = await http.json();
      const mcp = await app.handle(new Request(`${ORIGIN}/mcp/${ALPHA}`, {
        method: "POST", headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: `kb_${method}`, arguments: { payload: body } } }),
      }));
      const mcpBody = (await mcp.json()) as any;
      expect(mcpBody.result.isError).toBeUndefined();
      expect(JSON.parse(mcpBody.result.content[0].text)).toEqual(httpBody);
      expect((httpBody as { name: string }).name).toBe(body.name);
    }
  });
});
