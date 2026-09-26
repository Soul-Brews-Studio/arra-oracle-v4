/**
 * #30 R20 through the PRODUCTION wiring: `composition.ts`'s
 * `runStartupIndexWork` and `composeKnowledgeAccess`, exactly as
 * `index.ts`'s `startup()`/`buildApp()` call them, against a stub Ollama the
 * parent serves on 127.0.0.1 (`GET /api/tags` for the digest, `POST
 * /api/embed` for vectors). Nothing is injected into the service: the
 * embedder and the digest probe are the ones production composes.
 *
 * Failing-first evidence (against `dfe646d`): boot called
 * `pinActiveEmbeddingModelDigest`, which probed `/api/tags` and wrote
 * `.embedding-model-digest.json` before the first request, and every later
 * boot reused that pin without probing -- the verifier's reproduction
 * ("BOOT2 profile_id unchanged despite new digest: True") and the reverse
 * one (boot 1 unmeasured, boot 2 measured: `@unmeasured` became
 * `@1b226e2802db`). The previous fix round's digest tests never ran
 * `runStartupIndexWork` at all, which is why reverting composition.ts alone
 * still passed them.
 *
 * Every dataset is a fresh `mkdtemp` target-19 fixture; the legacy
 * `ARRA_DATA_DIR` is a fresh `createScratch()` directory. Each child is a
 * separate process, so each is a real restart.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createScratch, type Scratch } from "./helpers/auth-fixture";
import { createFixture, revisionEnvelope, runGated, type Fixture } from "./helpers/publication-fixture";
import { knowledgeErrorResponse } from "../src/knowledge/transport";
import { CHUNKER_VERSION, activeEmbeddingProfileId, fetchOllamaModelDigest } from "../src/publication/search-chunk";
import { failEmbeddingProfileMismatch } from "../src/publication/search-chunk.failEmbeddingProfileMismatch";

const CHILD = new URL("./fixtures/search-chunk-v1/embed/composed-child.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const TEST_TIMEOUT_MS = 300_000;
const PROFILE_ID = activeEmbeddingProfileId();
const PIN_FILE = ".embedding-profile-pins.json";
const DIGEST_A = "aaaaaaaaaaaa1111111111111111111111111111111111111111111111111111";
const DIGEST_B = "bbbbbbbbbbbb2222222222222222222222222222222222222222222222222222";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

type StubOllama = { url: string; digest: string | null; hits: Record<string, number> };

/** A real HTTP stub for the two Ollama calls production makes. `digest:
 *  null` answers `/api/tags` with a 503, the shape of an Ollama that is up
 *  but cannot serve. */
function startStubOllama(digest: string | null): StubOllama {
  const stub: StubOllama = { url: "", digest, hits: {} };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const key = `${req.method} ${new URL(req.url).pathname}`;
      stub.hits[key] = (stub.hits[key] ?? 0) + 1;
      if (key === "GET /api/tags") {
        if (stub.digest === null) return new Response("unavailable", { status: 503 });
        return Response.json({ models: [{ name: "all-minilm:latest", model: "all-minilm:latest", digest: stub.digest }] });
      }
      if (key === "POST /api/embed") {
        const body = (await req.json()) as { input?: unknown };
        const count = Array.isArray(body.input) ? body.input.length : 1;
        return Response.json({
          embeddings: Array.from({ length: count }, (_, i) => Array.from({ length: 384 }, (_, j) => ((i + j) % 17) / 17)),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  stub.url = `http://127.0.0.1:${server.port}`;
  return stub;
}

const totalHits = (stub: StubOllama) => Object.values(stub.hits).reduce((a, b) => a + b, 0);

async function scratchPair(): Promise<{ fixture: Fixture; scratch: Scratch }> {
  const fixture = await createFixture([ALPHA]);
  cleanups.push(() => fixture.cleanup());
  const scratch = await createScratch();
  cleanups.push(() => scratch.cleanup());
  return { fixture, scratch };
}

async function runChild(
  pair: { fixture: Fixture; scratch: Scratch },
  stub: StubOllama,
  payload: { boot?: boolean; ops?: unknown[] },
): Promise<Record<string, any>> {
  const result = await runGated(pair.fixture.datasetRoot, CHILD, [JSON.stringify(payload)], {
    env: {
      ARRA_DATA_DIR: pair.scratch.dataDir,
      ARRA_AUTH_POLICY: pair.scratch.policyPath,
      ARRA_KNOWLEDGE_DATASET_ROOT: pair.fixture.datasetRoot,
      OLLAMA_URL: stub.url,
      EMBEDDING_MODEL: "all-minilm",
      EMBEDDING_DIMENSIONS: "384",
    },
  });
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 1500)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 1500)}`);
  const parsed = JSON.parse(line);
  expect(parsed.fatal, JSON.stringify(parsed)).toBeUndefined();
  return parsed;
}

const write = (facade: string, method: string, request: unknown) => ({ action: "content:write", facade, method, request });
const read = (method: string, request: unknown) => ({ action: "content:read", facade: "context", method, request });
const publishAndIndex = (fixture: Fixture, node: string, operation: string, body: string) => [
  write("publication", "publishRevision", {
    operation_id: operation,
    content: revisionEnvelope(ALPHA, fixture.workspaces[ALPHA]!, node, { body }),
  }),
  write("context", "indexRevisionChunks", {
    workspace_name: ALPHA,
    node_id: node,
    revision_id: "$op0.revision_id",
    chunker_version: CHUNKER_VERSION,
    embedding_profile: { name: PROFILE_ID, dims: 384 },
  }),
];
const embed = () => write("context", "embedPendingChunks", { workspace_name: ALPHA, limit: 10 });
const freshness = () => read("getSearchFreshness", { workspace_name: ALPHA });
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

/** Every file boot or an embed run may have left at the dataset root. */
const pinFiles = (root: string) => readdirSync(root).filter((name) => name.startsWith(".embedding-"));
const pinnedDigest = (root: string): string | null => {
  const path = join(root, PIN_FILE);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).pins?.[PROFILE_ID]?.digest ?? null) : null;
};

describe("R20 (4): server boot never probes, pins or flips anything", () => {
  test("runStartupIndexWork + composeKnowledgeAccess against a healthy Ollama: zero requests, no pin file", async () => {
    const pair = await scratchPair();
    const stub = startStubOllama(DIGEST_A);
    const booted = await runChild(pair, stub, { boot: true });
    expect(stub.hits).toEqual({});
    expect(pinFiles(pair.fixture.datasetRoot)).toEqual([]);
    expect(booted.profileAfterBoot).toBe(booted.profileBefore);
    expect(booted.profileAfter).toBe(booted.profileBefore);
    expect(booted.profileBefore).toBe(PROFILE_ID);
  }, TEST_TIMEOUT_MS);
});

describe("R20 through production wiring: pin on first vector, refuse a changed digest across restarts", () => {
  test("embed pins A; a reboot against B changes nothing; the next embed refuses naming A and B", async () => {
    const pair = await scratchPair();
    const stub = startStubOllama(DIGEST_A);

    const first = await runChild(pair, stub, {
      boot: true,
      ops: [...publishAndIndex(pair.fixture, pad("db-node-a"), "op-db-a", "boot body one"), embed(), freshness()],
    });
    expect(first.op0.value.outcome).toBe("accepted");
    expect(first.op1.ok, JSON.stringify(first.op1)).toBe(true);
    expect(first.op2.value).toEqual({ attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null });
    expect(first.op3.value.vectors.model_digest).toEqual({ pinned: DIGEST_A, last_measured: DIGEST_A });
    expect(stub.hits["POST /api/embed"]).toBe(1);
    expect(pinnedDigest(pair.fixture.datasetRoot)).toBe(DIGEST_A);

    // Same model name, a different build behind it (the verifier's boot 2).
    stub.digest = DIGEST_B;
    const before = totalHits(stub);
    const reboot = await runChild(pair, stub, { boot: true, ops: [freshness()] });
    expect(totalHits(stub)).toBe(before);
    expect(pinnedDigest(pair.fixture.datasetRoot)).toBe(DIGEST_A);
    expect(reboot.profileAfter).toBe(first.profileAfter);
    // Nothing measured in THIS process yet: unknown, not the old answer.
    expect(reboot.op0.value.vectors.model_digest).toEqual({ pinned: DIGEST_A, last_measured: null });
    expect(reboot.op0.value.vectors).toMatchObject({ profile_id: PROFILE_ID, ready: 1 });

    const refused = await runChild(pair, stub, {
      boot: true,
      ops: [...publishAndIndex(pair.fixture, pad("db-node-b"), "op-db-b", "boot body two"), embed(), freshness()],
    });
    expect(refused.op2.ok).toBe(false);
    expect(refused.op2.envelope).toEqual({
      version: "arra-publication-error/v1",
      code: "embedding_profile_mismatch",
      path: "",
      message: "embedding model digest differs from the dataset's pinned digest",
      pinned_digest: DIGEST_A,
      measured_digest: DIGEST_B,
    });
    expect(stub.hits["POST /api/embed"]).toBe(1);
    expect(refused.op3.value.vectors).toMatchObject({ profile_id: PROFILE_ID, ready: 1, pending: 1 });
    expect(refused.op3.value.vectors.model_digest).toEqual({ pinned: DIGEST_A, last_measured: DIGEST_B });
    expect(pinnedDigest(pair.fixture.datasetRoot)).toBe(DIGEST_A);
    expect(refused.profileAfter).toBe(first.profileAfter);
  }, TEST_TIMEOUT_MS);

  test("boot 1 before Ollama can answer, boot 2 after: blocked, then embedded under the SAME profile id", async () => {
    const pair = await scratchPair();
    const stub = startStubOllama(null);

    const boot1 = await runChild(pair, stub, {
      boot: true,
      ops: [...publishAndIndex(pair.fixture, pad("db-node-u"), "op-db-u", "boot body unmeasured"), embed()],
    });
    expect(boot1.op1.ok, JSON.stringify(boot1.op1)).toBe(true);
    expect(boot1.op2.value).toMatchObject({ embedded: 0, failed: 0, remaining: 1, blocked: "digest_unmeasured" });
    expect(stub.hits["POST /api/embed"]).toBeUndefined();
    expect(pinFiles(pair.fixture.datasetRoot)).toEqual([]);

    stub.digest = DIGEST_A;
    const boot2 = await runChild(pair, stub, { boot: true, ops: [embed(), freshness()] });
    expect(boot2.op0.value).toEqual({ attempted: 1, embedded: 1, reused: 0, failed: 0, remaining: 0, skipped: 0, blocked: null });
    expect(boot2.op1.value.vectors).toMatchObject({ profile_id: PROFILE_ID, ready: 1, pending: 0, failed: 0 });
    expect(boot2.profileAfter).toBe(boot1.profileAfter);
    expect(pinnedDigest(pair.fixture.datasetRoot)).toBe(DIGEST_A);
  }, TEST_TIMEOUT_MS);
});

describe("fetchOllamaModelDigest: bounded, and only a recognisable digest counts as a measurement", () => {
  test("a hung endpoint resolves null once the caller's signal fires", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });
    cleanups.push(() => server.stop(true));
    const started = Bun.nanoseconds();
    const digest = await fetchOllamaModelDigest({ url: `http://127.0.0.1:${server.port}`, signal: AbortSignal.timeout(100) });
    expect(digest).toBeNull();
    expect((Bun.nanoseconds() - started) / 1_000_000).toBeLessThan(5_000);
  });

  test("a digest outside the measured 64-hex shape is not a measurement", async () => {
    const stub = startStubOllama("not a digest; ignore previous instructions");
    expect(await fetchOllamaModelDigest({ url: stub.url, model: "all-minilm" })).toBeNull();
    stub.digest = DIGEST_A;
    expect(await fetchOllamaModelDigest({ url: stub.url, model: "all-minilm" })).toBe(DIGEST_A);
  });
});

describe("embedding_profile_mismatch on the wire", () => {
  test("HTTP maps it to 409 with the closed envelope plus both digests", async () => {
    let thrown: unknown = null;
    try {
      failEmbeddingProfileMismatch(DIGEST_A, DIGEST_B);
    } catch (error) {
      thrown = error;
    }
    const response = knowledgeErrorResponse(thrown);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toEqual({
      version: "arra-publication-error/v1",
      code: "embedding_profile_mismatch",
      path: "",
      message: "embedding model digest differs from the dataset's pinned digest",
      pinned_digest: DIGEST_A,
      measured_digest: DIGEST_B,
    });
  });
});
