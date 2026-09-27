// #31 transport ownership evidence -- envelope fidelity, envelope distinctness,
// error-class laundering and cross-tenant admission, all at the HTTP boundary
// `handleKnowledgeRequest` (app/server/src/knowledge/transport.ts) builds.
//
// No writer gate is needed for anything in this file: every case here is a
// property of the TRANSPORT's own error-mapping and admission code, which run
// identically whether the underlying bundle is real or not. The real gated
// writer, the shared-owner poison and the write-serialization properties are
// PARENT #31's kernel-level guarantee (already proven in
// publication-ownership.test.ts / context-ownership.test.ts and friends) and
// this file does not re-derive them; what this file proves is that the
// TRANSPORT does not lose, relabel or merge those guarantees crossing the
// wire. See `test/transport-recovery.test.ts` for the real-writer poison and
// concurrent-write lanes, which do need the gate.
//
// Every thrown error below is a REAL instance of the package's own error
// classes (`ContractError`, `PublicationError`, `TaxonomyError`) -- never a
// hand-built object shaped like one -- so `toJSON()` and `STATUS_FOR_CODE` are
// exercised exactly as production code exercises them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.createApp";
import type { KnowledgeAccess } from "../src/knowledge/transport";
import type { KnowledgeBundle } from "../src/knowledge/registry";
import { ContractError } from "../src/contracts/errors";
import { PublicationError } from "../src/publication/errors";
import { TaxonomyError } from "../src/publication/taxonomy";
import type { OperationService } from "../src/auth/service.createOperationService";
import type { createMcpAdapter } from "../src/mcp";

const ORIGIN = "http://127.0.0.1:3939";
const url = (path: string) => `${ORIGIN}${path}`;

function tokenFor(seed: string) {
  const token = createHash("sha256").update(seed, "ascii").digest("hex"); // 64 lowercase hex, matches BEARER_PATTERN
  const sha256 = createHash("sha256").update(token, "ascii").digest("hex");
  return { token, sha256 };
}
const ACME = tokenFor("acme-token-seed");
const BETA = tokenFor("beta-token-seed");

const NOT_BEFORE = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";

// Two principals, each scoped to EXACTLY one workspace -- the minimum shape
// that can prove cross-tenant isolation rather than merely single-tenant
// admission.
const policyDocument = () => ({
  version: "arra-auth/v1",
  principals: [
    {
      id: "acme-op",
      disabled: false,
      workspaces: [{ name: "acme", actions: ["content:read", "content:write"] }],
      global_actions: [],
    },
    {
      id: "beta-op",
      disabled: false,
      workspaces: [{ name: "beta", actions: ["content:read", "content:write"] }],
      global_actions: [],
    },
  ],
  credentials: [
    {
      id: "cred-acme",
      principal_id: "acme-op",
      sha256: ACME.sha256,
      not_before: NOT_BEFORE,
      expires_at: EXPIRES_AT,
      revoked: false,
    },
    {
      id: "cred-beta",
      principal_id: "beta-op",
      sha256: BETA.sha256,
      not_before: NOT_BEFORE,
      expires_at: EXPIRES_AT,
      revoked: false,
    },
  ],
});

let policyPath: string;
let dataDir: string;
let app: { handle: (request: Request) => Promise<Response> };

/**
 * A bundle whose EVERY method throws a caller-selected error, and whose
 * `getVocabulary` runs the REAL governed parser first (matching the existing
 * `transport-service.test.ts` precedent), so scope-agreement and static
 * grammar are still exercised by real contract code, not a stand-in.
 */
function throwingBundle(makeError: () => unknown): KnowledgeBundle {
  const thrower = async () => {
    throw makeError();
  };
  return {
    publication: { getAcceptedHead: thrower } as never,
    taxonomy: { getTerm: thrower, getVocabulary: thrower } as never,
    context: { getPeer: thrower } as never,
    evidence: { getRevisionAssociations: thrower } as never,
  };
}

let access: { getBundle: (action: string) => Promise<KnowledgeBundle> };

const request = (path: string, init: RequestInit = {}) =>
  new Request(url(path), { ...init, headers: { host: "127.0.0.1:3939", ...(init.headers ?? {}) } });

const send = (path: string, init?: RequestInit) => app.handle(request(path, init));

const authedJson = (token: string, bodyBytes: Uint8Array | string): RequestInit => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: bodyBytes as BodyInit,
});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "arra-v4-knowledge-ownership-"));
  policyPath = join(dataDir, "policy.json");
  await writeFile(policyPath, JSON.stringify(policyDocument()), { encoding: "utf-8", mode: 0o600 });

  const service = {} as unknown as OperationService; // unused: no /api/memories route is exercised
  const mcpHandle = (() => {
    throw new Error("unused in this suite");
  }) as unknown as ReturnType<typeof createMcpAdapter>;

  // `access` is reassigned per test via a mutable indirection object, so one
  // `createApp` can be reused across every case in this file.
  const indirectAccess: KnowledgeAccess = {
    getBundle: (a) => access.getBundle(a),
  };

  app = createApp({ origin: ORIGIN }, service, mcpHandle, {
    knowledge: { policyPath, access: indirectAccess },
  });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

// ── envelope fidelity ───────────────────────────────────────────────────────

describe("envelope fidelity crossing the transport", () => {
  test("a ContractError (arra-error/v1) serializes as exactly version, code, path, message", async () => {
    access = { getBundle: async () => throwingBundle(() => new ContractError("invalid_type", "/x", "expected a string")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(400);
    const envelope = await res.json();
    expect(Object.keys(envelope).sort()).toEqual(["code", "message", "path", "version"]);
    expect(envelope).toEqual({ version: "arra-error/v1", code: "invalid_type", path: "/x", message: "expected a string" });
  });

  test("a PublicationError (arra-publication-error/v1) serializes as exactly version, code, path, message", async () => {
    access = { getBundle: async () => throwingBundle(() => new PublicationError("not_found", "")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(404);
    const envelope = await res.json();
    expect(Object.keys(envelope).sort()).toEqual(["code", "message", "path", "version"]);
    expect(envelope).toEqual({
      version: "arra-publication-error/v1",
      code: "not_found",
      path: "",
      message: "node not found",
    });
  });

  test("a TaxonomyError (arra-taxonomy-error/v1) serializes as exactly version, code, path, message", async () => {
    access = { getBundle: async () => throwingBundle(() => new TaxonomyError("not_found", "")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(404);
    const envelope = await res.json();
    expect(Object.keys(envelope).sort()).toEqual(["code", "message", "path", "version"]);
    expect(envelope).toEqual({
      version: "arra-taxonomy-error/v1",
      code: "not_found",
      path: "",
      message: "taxonomy row not found",
    });
  });

  // BITE TEST for the fidelity claim above: an error object that ALSO carries
  // `name`, a `stack`, and an extra field must still emit exactly four keys,
  // because `toJSON()` -- not the error object itself -- is what the
  // transport serializes (`JSON.stringify(error.toJSON())` in
  // `knowledgeErrorResponse`). If the transport ever switched to
  // `JSON.stringify(error)` directly, this is the case that would fail.
  test("BITE: an error's own enumerable extras never leak through toJSON", async () => {
    access = {
      getBundle: async () =>
        throwingBundle(() => {
          const error = new PublicationError("not_found", "");
          (error as unknown as Record<string, unknown>).extra_field = "should never appear";
          return error;
        }),
    };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    const envelope = await res.json();
    expect(Object.keys(envelope).sort()).toEqual(["code", "message", "path", "version"]);
    expect(envelope.name).toBeUndefined();
    expect(envelope.stack).toBeUndefined();
    expect(envelope.extra_field).toBeUndefined();
  });
});

// ── two envelopes stay distinct ─────────────────────────────────────────────

describe("governed and publication envelopes are never conflated", () => {
  test("a real duplicate-key parse failure is arra-error/v1, never arra-publication-error/v1", async () => {
    access = { getBundle: async () => throwingBundle(() => new PublicationError("invalid_request", "")) };
    // Hand-written duplicate key: exercises the REAL governed parser inside
    // getVocabulary, ahead of the fake bundle ever running.
    const body = '{"workspace_name":"acme","vocabulary_id":"abcdefghijklmnopqrstu","vocabulary_id":"zzzzzzzzzzzzzzzzzzzzz"}';
    const res = await send("/api/knowledge/acme/getVocabulary", authedJson(ACME.token, body));
    expect(res.status).toBe(400);
    const envelope = await res.json();
    expect(envelope.version).toBe("arra-error/v1");
    expect(envelope.code).toBe("duplicate_key");
  });

  test("a publication-level not_found is arra-publication-error/v1, never arra-error/v1", async () => {
    access = { getBundle: async () => throwingBundle(() => new PublicationError("not_found", "")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    const envelope = await res.json();
    expect(envelope.version).toBe("arra-publication-error/v1");
    expect(envelope.version).not.toBe("arra-error/v1");
  });

  test("a taxonomy-level not_found is arra-taxonomy-error/v1, distinct from the publication envelope with the SAME code", async () => {
    access = { getBundle: async () => throwingBundle(() => new TaxonomyError("not_found", "")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    const envelope = await res.json();
    // Same code, same status (404), DIFFERENT version -- the case that would
    // pass a check asserting only `code`.
    expect(envelope.code).toBe("not_found");
    expect(envelope.version).toBe("arra-taxonomy-error/v1");
    expect(envelope.version).not.toBe("arra-publication-error/v1");
  });
});

// ── no error-class laundering ────────────────────────────────────────────────

describe("no error-class laundering", () => {
  test("integrity_failure arrives as integrity_failure, not flattened to a generic 500 body or to recovery_required", async () => {
    access = { getBundle: async () => throwingBundle(() => new PublicationError("integrity_failure", "")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(500);
    const envelope = await res.json();
    expect(envelope.code).toBe("integrity_failure");
    expect(envelope.code).not.toBe("recovery_required");
    expect(envelope.version).toBe("arra-publication-error/v1");
  });

  test("recovery_required arrives as recovery_required, at its OWN status (503), not integrity_failure's 500", async () => {
    access = { getBundle: async () => throwingBundle(() => new PublicationError("recovery_required", "")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(503);
    const envelope = await res.json();
    expect(envelope.code).toBe("recovery_required");
  });

  test("an unknown, non-envelope error is a fixed generic 500 body, and its own message text never escapes", async () => {
    access = { getBundle: async () => throwingBundle(() => new Error("leak candidate: /etc/shadow contents")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain("leak candidate");
    expect(JSON.parse(raw)).toEqual({ error: "internal" });
  });

  // #86 fix, landed here: `TaxonomyError`'s own code list
  // (`TAXONOMY_ERROR_CODES` in src/publication/taxonomy.ts) includes
  // `"conflict"`. `STATUS_FOR_CODE` in src/knowledge/transport.ts now maps it
  // to 409, its own status, distinct from an unrelated integrity failure's
  // 500. This test previously asserted the OLD, buggy behaviour (status 500,
  // indistinguishable from a server fault) as a recorded finding; updating it
  // to 409 IS the fix landing, not a silent behaviour change.
  test("taxonomy conflict arrives as 409, distinct from a server fault's 500", async () => {
    access = { getBundle: async () => throwingBundle(() => new TaxonomyError("conflict", "/term_name")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    const envelope = await res.json();
    expect(envelope.code).toBe("conflict"); // the CODE survives untouched
    expect(res.status).toBe(409); // and the STATUS is now its own, not 500's generic fault
  });
});

// ── cross-tenant isolation (real admit()/loadPolicy(), no mocks) ───────────

describe("cross-tenant admission", () => {
  test("a token scoped to acme is refused for the beta route even when the body agrees with the route", async () => {
    access = { getBundle: async () => throwingBundle(() => new Error("must not be reached: admission should refuse first")) };
    const body = JSON.stringify({ workspace_name: "beta" });
    const res = await send("/api/knowledge/beta/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(403);
  });

  test("a token scoped to beta is refused for the acme route even when the body agrees with the route", async () => {
    access = { getBundle: async () => throwingBundle(() => new Error("must not be reached: admission should refuse first")) };
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(BETA.token, body));
    expect(res.status).toBe(403);
  });

  test("each token is admitted for its OWN workspace", async () => {
    access = { getBundle: async () => throwingBundle(() => new PublicationError("not_found", "")) };
    const acmeBody = JSON.stringify({ workspace_name: "acme" });
    const acmeRes = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, acmeBody));
    expect(acmeRes.status).toBe(404); // reached the bundle: admitted, then not_found

    const betaBody = JSON.stringify({ workspace_name: "beta" });
    const betaRes = await send("/api/knowledge/beta/getPeer", authedJson(BETA.token, betaBody));
    expect(betaRes.status).toBe(404);
  });

  test("naming the OTHER tenant's workspace in the body is refused before admission ever runs (scope is not authorization)", async () => {
    access = { getBundle: async () => throwingBundle(() => new Error("must not be reached: scope mismatch refuses first")) };
    // acme's own valid token, but the body claims beta while the route says acme.
    const body = JSON.stringify({ workspace_name: "beta" });
    const res = await send("/api/knowledge/acme/getPeer", authedJson(ACME.token, body));
    expect(res.status).toBe(400); // scope mismatch, not 403 -- checked before admission
  });

  test("no bearer token at all is unauthenticated, for either tenant's route", async () => {
    const body = JSON.stringify({ workspace_name: "acme" });
    const res = await send("/api/knowledge/acme/getPeer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
  });
});
