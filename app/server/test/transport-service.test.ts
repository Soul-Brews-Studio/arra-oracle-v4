// #31 transport-exposure smoke test.
//
// One file, minimal, proving the property that actually distinguishes a
// correct transport from one that merely forwards bytes: the REFUSALS
// survive it. A transport that JSON.parses before handing bytes to the
// governed facade would pass every happy-path test here and still silently
// destroy duplicate-key rejection and the byte-exact size cap -- so those
// are asserted first, ahead of the round trip.
//
// No live LanceDB dataset is used. `getVocabulary` is backed by a fake
// bundle that calls the REAL `parseGetVocabulary` from
// `publication/taxonomy.ts` -- the actual governed parser this kernel ships
// -- so every parse-level assertion below exercises real contract code, not
// a stand-in. Only the storage read after a successful parse is faked,
// because standing up a full LanceDB target-19 dataset is out of scope for
// a transport smoke test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.createApp";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import type { KnowledgeBundle } from "../src/knowledge/registry";
import { parseGetVocabulary } from "../src/publication/taxonomy";
import type { OperationService } from "../src/auth/service.createOperationService";
import type { createMcpAdapter } from "../src/mcp";

const ORIGIN = "http://127.0.0.1:3939";
const url = (path: string) => `${ORIGIN}${path}`;

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// sha256("Bearer-token digest") precomputed the same way `auth-fixture.ts` does
// for its own synthetic tokens; re-derived below so agreement is checked
// in-test rather than trusted from a comment.
import { createHash } from "node:crypto";
const TOKEN_SHA256 = createHash("sha256").update(TOKEN, "ascii").digest("hex");

const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

const policyDocument = () => ({
  version: "arra-auth/v1",
  principals: [
    {
      id: "acme-op",
      disabled: false,
      workspaces: [{ name: "acme", actions: ["content:read", "content:write"] }],
      global_actions: [],
    },
  ],
  credentials: [
    {
      id: "cred-acme",
      principal_id: "acme-op",
      sha256: TOKEN_SHA256,
      not_before: NOT_BEFORE,
      expires_at: EXPIRES_AT,
      revoked: false,
    },
  ],
});

let policyPath: string;
let dataDir: string;
let app: { handle: (request: Request) => Promise<Response> };

/** A fake bundle: real governed parsing, faked storage. See file header. */
const fakeBundle: KnowledgeBundle = {
  publication: {} as never,
  taxonomy: {
    getVocabulary: async (bytes: Uint8Array) => {
      const request = parseGetVocabulary(bytes); // REAL governed parser
      return {
        id: request.vocabulary_id,
        workspace_name: request.workspace_name,
        // A synthetic Int64-shaped column, as decimal TEXT -- exactly the
        // shape every real `encode*Row` helper in this package produces.
        // Proves the TRANSPORT never coerces it to a JS number.
        weight_v1: "9007199254740993",
      };
    },
    getTerm: (() => {
      throw new Error("unused in this smoke test");
    }) as never,
  } as never,
  context: {} as never,
  evidence: {} as never,
};

const access: KnowledgeAccess = { getBundle: async () => fakeBundle };

const request = (path: string, init: RequestInit = {}) =>
  new Request(url(path), { ...init, headers: { host: "127.0.0.1:3939", ...(init.headers ?? {}) } });

const send = (path: string, init?: RequestInit) => app.handle(request(path, init));

const authedJson = (bodyBytes: Uint8Array | string): RequestInit => ({
  method: "POST",
  headers: {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  },
  body: bodyBytes as BodyInit,
});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "arra-v4-knowledge-transport-"));
  policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policyDocument()), { encoding: "utf-8", mode: 0o600 });

  const service = {} as unknown as OperationService; // unused: no /api/memories route is exercised
  const mcpHandle = (() => {
    throw new Error("unused in this smoke test");
  }) as unknown as ReturnType<typeof createMcpAdapter>;

  app = createApp({ origin: ORIGIN }, service, mcpHandle, {
    knowledge: { policyPath, access },
  });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("refusals survive the transport", () => {
  test("a duplicate key returns duplicate_key at the right pointer", async () => {
    // Hand-written, not JSON.stringify'd: a JS object literal cannot express
    // a duplicate key, and that is exactly the gap this test exists to catch.
    const body = '{"workspace_name":"acme","vocabulary_id":"abcdefghijklmnopqrstu","vocabulary_id":"zzzzzzzzzzzzzzzzzzzzz"}';
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(body));
    expect(res.status).toBe(400);
    const envelope = await res.json();
    expect(envelope.version).toBe("arra-error/v1");
    expect(envelope.code).toBe("duplicate_key");
    expect(envelope.path).toBe("/vocabulary_id");
    expect(envelope.name).toBeUndefined(); // toJSON emits no `name` field
  });

  test("a body over 1 MiB is refused by BYTES", async () => {
    const oversized = new Uint8Array(1024 * 1024 + 1).fill(0x20);
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(oversized));
    expect(res.status).toBe(413);
  });

  test("malformed UTF-8 is refused", async () => {
    // A lone continuation byte: invalid as a UTF-8 lead byte.
    const bad = new TextEncoder().encode('{"workspace_name":"acme","vocabulary_id":"');
    const malformed = new Uint8Array([...bad, 0xff, 0xfe]);
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(malformed));
    expect(res.status).toBe(400);
    const envelope = await res.json();
    expect(envelope.version).toBe("arra-error/v1");
    expect(["invalid_json", "invalid_unicode"]).toContain(envelope.code);
  });
});

describe("valid request round trip", () => {
  test("a known-bad field returns the exact governed envelope, unchanged", async () => {
    // Missing `vocabulary_id`: passes admission (workspace_name is present
    // and matches the route), then fails INSIDE the real governed parser.
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(body));
    expect(res.status).toBe(400);
    const envelope = await res.json();
    expect(envelope).toEqual({
      version: "arra-error/v1",
      code: "missing_field",
      path: "/vocabulary_id",
      message: envelope.message,
    });
    expect(typeof envelope.message).toBe("string");
    expect(envelope.name).toBeUndefined();
  });

  test("a valid request round-trips, and Int64 survives as decimal TEXT", async () => {
    const body = JSON.stringify({ workspace_name: "acme", vocabulary_id: "abcdefghijklmnopqrstu" });
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(body));
    expect(res.status).toBe(200);
    // Assert on the RAW text before JSON.parse: a JSON number and a
    // JSON string that happens to look numeric are indistinguishable once
    // `JSON.parse` has already run, so the on-the-wire form is what matters.
    const raw = await res.text();
    expect(raw).toContain('"weight_v1":"9007199254740993"');
    const parsed = JSON.parse(raw);
    expect(typeof parsed.weight_v1).toBe("string");
    expect(parsed.weight_v1).toBe("9007199254740993");
    expect(parsed.id).toBe("abcdefghijklmnopqrstu");
  });
});

describe("scope is not authorization", () => {
  test("a body naming a different workspace than the route is refused", async () => {
    const body = JSON.stringify({ workspace_name: "someone-elses-bank", vocabulary_id: "abcdefghijklmnopqrstu" });
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(body));
    expect(res.status).toBe(400);
  });

  test("no bearer token is unauthenticated", async () => {
    const body = JSON.stringify({ workspace_name: "acme", vocabulary_id: "abcdefghijklmnopqrstu" });
    const res = await send("/api/knowledge/acme/getVocabulary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });
});
