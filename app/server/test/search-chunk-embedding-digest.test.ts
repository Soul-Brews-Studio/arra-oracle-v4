/**
 * #30 fix round: findings 1 and 4 on `search-chunk.profiles.ts` +
 * `composition.ts` -- the startup embedding-model-digest probe.
 *
 * Failing-first evidence (measured by the independent verifier against
 * pre-fix HEAD, `ff1fccd`): `runStartupIndexWork` awaited
 * `fetchOllamaModelDigest()` with NO signal and no timeout. Against a TCP
 * endpoint that accepts a connection and never answers, the call was "STILL
 * PENDING after 20000ms" and only actually settled after 300007 ms -- Bun's
 * own default `fetch` timeout -- holding up server startup, and therefore
 * every content save, for up to 5 minutes on every boot a hung Ollama was
 * reachable-but-silent. Separately, because the digest was measured fresh
 * from a live probe on EVERY boot with no persistence, two boots of the
 * IDENTICAL installed model produced two different `profile_id`s whenever
 * Ollama's reachability differed between them, orphaning every vector
 * embedded under the first id.
 *
 * These tests exercise `pinActiveEmbeddingModelDigest` directly (never
 * `runStartupIndexWork`, which also touches the unrelated legacy `db.ts` FTS
 * index against `ARRA_DATA_DIR` -- exactly why the digest logic was pulled
 * into its own file) against a REAL hung TCP listener and a REAL fake
 * Ollama HTTP server, on fresh `mkdtemp` roots. No LanceDB dataset, no
 * writer gate, no real Ollama.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_EMBEDDING_MODEL_NAME,
  configureActiveEmbeddingModelDigest,
  getActiveEmbeddingModelDigest,
} from "../src/publication/search-chunk.profiles";
import { pinActiveEmbeddingModelDigest } from "../src/publication/search-chunk.pinActiveEmbeddingModelDigest";
import { readPinnedModelDigest } from "../src/publication/search-chunk.readPinnedModelDigest";
import { writePinnedModelDigest } from "../src/publication/search-chunk.writePinnedModelDigest";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  // Every test starts from the same "nothing measured yet" state.
  configureActiveEmbeddingModelDigest(null);
});

/** A real TCP endpoint that accepts a connection and never writes a byte
 *  back -- the exact shape the verifier measured a hung Ollama as. */
function startHungServer(): { url: string; stop: () => void } {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A real fake Ollama, answering `/api/tags` the measured shape
 *  (`GET /api/tags` -> `models[].digest`, per `fetchOllamaModelDigest`'s doc). */
function startFakeOllama(digest: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/api/tags") {
        return Response.json({ models: [{ name: "all-minilm", digest }] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

async function scratchRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arra-v4-digest-pin-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("pinActiveEmbeddingModelDigest: finding 1, bounded against a hung Ollama", () => {
  test("resolves within the configured timeout, never Bun's ~300s fetch default", async () => {
    const { url } = startHungServer();
    const datasetRoot = await scratchRoot();
    const started = Bun.nanoseconds();
    await pinActiveEmbeddingModelDigest({
      ARRA_KNOWLEDGE_DATASET_ROOT: datasetRoot,
      OLLAMA_URL: url,
      ARRA_STARTUP_DIGEST_TIMEOUT_MS: "80",
    } as NodeJS.ProcessEnv);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;
    // Generous margin above the 80ms configured timeout (CI scheduling), but
    // nowhere NEAR the unbounded pre-fix failure mode (measured 300007 ms).
    expect(elapsedMs).toBeLessThan(3_000);
    expect(elapsedMs).toBeGreaterThanOrEqual(70);
    // An unreachable/hung Ollama leaves the digest unmeasured, same as before
    // this fix -- boundedness never turns a real timeout into a fabricated id.
    expect(getActiveEmbeddingModelDigest()).toBeNull();
    // Nothing is persisted for a failed probe: the next boot must try again.
    expect(readPinnedModelDigest(datasetRoot, ACTIVE_EMBEDDING_MODEL_NAME)).toBeNull();
  });
});

describe("pinActiveEmbeddingModelDigest: finding 4, identity is pinned across reboots", () => {
  test("boot 2 reuses boot 1's measured digest even when Ollama is unreachable on boot 2", async () => {
    const digest = "fixround0000measured0000digest00000000000000000000000000000000";
    const ollama = startFakeOllama(digest);
    const datasetRoot = await scratchRoot();

    // Boot 1: Ollama answers -- a real digest is measured AND persisted.
    await pinActiveEmbeddingModelDigest({
      ARRA_KNOWLEDGE_DATASET_ROOT: datasetRoot,
      OLLAMA_URL: ollama.url,
    } as NodeJS.ProcessEnv);
    expect(getActiveEmbeddingModelDigest()).toBe(digest);

    // Simulate the singleton resetting the way it genuinely does across a
    // real process restart.
    configureActiveEmbeddingModelDigest(null);
    ollama.stop();
    const { url: hungUrl } = startHungServer();

    // Boot 2: Ollama is now unreachable (hung). Pre-fix, this boot would
    // re-probe and land on `unmeasured` -- a DIFFERENT profile_id than boot
    // 1's, orphaning every vector embedded under it. With the pin in place,
    // this boot must reuse boot 1's digest and never even touch the network.
    const started = Bun.nanoseconds();
    await pinActiveEmbeddingModelDigest({
      ARRA_KNOWLEDGE_DATASET_ROOT: datasetRoot,
      OLLAMA_URL: hungUrl,
      ARRA_STARTUP_DIGEST_TIMEOUT_MS: "80",
    } as NodeJS.ProcessEnv);
    const elapsedMs = (Bun.nanoseconds() - started) / 1_000_000;

    expect(getActiveEmbeddingModelDigest()).toBe(digest);
    // No network probe was even attempted: resolves far faster than the
    // configured 80ms timeout would allow if it HAD probed the hung server.
    expect(elapsedMs).toBeLessThan(50);
  });

  test("no ARRA_KNOWLEDGE_DATASET_ROOT: no pin lookup, no persistence, unaffected behavior", async () => {
    const digest = "no0root0000000000000000000000000000000000000000000000000000000";
    const ollama = startFakeOllama(digest);
    await pinActiveEmbeddingModelDigest({ OLLAMA_URL: ollama.url } as NodeJS.ProcessEnv);
    expect(getActiveEmbeddingModelDigest()).toBe(digest);
  });
});

describe("readPinnedModelDigest / writePinnedModelDigest: a stale pin under a different model is ignored", () => {
  test("a pin written for model A is never returned when asked under model B", async () => {
    const datasetRoot = await scratchRoot();
    expect(readPinnedModelDigest(datasetRoot, "model-a")).toBeNull();
    writePinnedModelDigest(datasetRoot, "model-a", "digest-for-a");
    expect(readPinnedModelDigest(datasetRoot, "model-a")).toBe("digest-for-a");
    // EMBEDDING_MODEL changed since this pin was written: must not silently
    // reattach model A's digest to model B's identity.
    expect(readPinnedModelDigest(datasetRoot, "model-b")).toBeNull();
  });

  test("a missing or unwritable root reads as not-yet-pinned, never throws", async () => {
    expect(readPinnedModelDigest(join(tmpdir(), "arra-v4-digest-pin-does-not-exist"), "any-model")).toBeNull();
  });
});
