/**
 * R13 (CI must actually pass, docs/overnight/DECISIONS.md): the child
 * harness must never hand a child an argv or env string Linux will refuse.
 *
 * Linux fails exec with E2BIG for any single argv/envp string over
 * MAX_ARG_STRLEN (131072 bytes with its NUL); macOS has no per-string limit.
 * Three suites were green on the dev box and died on every GitHub run
 * (36260049043, 36265042727, 36265462602) with
 * `E2BIG: argument list too long, posix_spawn .../python`:
 *   - mcp-v3-writes: its `too_big` step carries a 300 KiB pattern, so
 *     `beforeAll` threw and bun reported an "(unnamed)" failure
 *   - session-link-service: the WIDE node plants 1025 raw link rows
 *   - list-pagination-isolation: the whole op plan rides in one argument,
 *     so the file's top-level await threw "between tests"
 *
 * These tests hold the Linux limit on EVERY platform, so the next oversized
 * argument fails on the dev box too instead of only on the runner.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGFILE_PREFIX, ARGV_INLINE_MAX_BYTES, LINUX_MAX_ARG_STRING_BYTES } from "./helpers/argv.constants";
import { runGated, runOwnedChild, spawnGatedChild } from "./helpers/publication-fixture";

const ECHO = new URL("./fixtures/argv-v1/echo-payload.ts", import.meta.url).pathname;

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
/** A fresh directory for the writer gate to lock; the echo child writes nothing. */
async function gateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "arra-argv-"));
  roots.push(root);
  return root;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Over the Linux limit in BYTES while under it in UTF-16 units: the check must count bytes. */
const OVERSIZED = JSON.stringify({ blob: "x".repeat(300 * 1024), thai: "ลืม".repeat(1000) });

type Echo = {
  label: string;
  argvBytes: number[];
  rawPayload: string;
  payloadBytes: number;
  payloadSha256: string;
  gated: boolean;
};

describe("argv spill: an oversized payload reaches a gated child intact, within the Linux limit", () => {
  test("runGated: the payload arrives byte-for-byte and no argv string exceeds 131071 bytes", async () => {
    expect(Buffer.byteLength(OVERSIZED, "utf8")).toBeGreaterThan(LINUX_MAX_ARG_STRING_BYTES);
    const result = await runGated(await gateRoot(), ECHO, ["runGated", OVERSIZED]);
    expect(result.code, result.stderr).toBe(0);
    const echo = JSON.parse(result.stdout.trim()) as Echo;

    expect(echo.gated).toBe(true);
    expect(Math.max(...echo.argvBytes)).toBeLessThanOrEqual(LINUX_MAX_ARG_STRING_BYTES);
    expect(echo.payloadBytes).toBe(Buffer.byteLength(OVERSIZED, "utf8"));
    expect(echo.payloadSha256).toBe(sha256(OVERSIZED));

    // The spill file is the parent's own and is gone once the child closed.
    expect(echo.rawPayload.startsWith(ARGFILE_PREFIX)).toBe(true);
    expect(existsSync(echo.rawPayload.slice(ARGFILE_PREFIX.length))).toBe(false);
  }, 60_000);

  test("spawnGatedChild: the same, and the spill is removed when the child exits", async () => {
    const child = spawnGatedChild(await gateRoot(), ECHO, ["spawnGatedChild", OVERSIZED]);
    try {
      const echo = JSON.parse(await child.nextLine()) as Echo;
      expect(await child.wait()).toBe(0);

      expect(echo.gated).toBe(true);
      expect(Math.max(...echo.argvBytes)).toBeLessThanOrEqual(LINUX_MAX_ARG_STRING_BYTES);
      expect(echo.payloadSha256).toBe(sha256(OVERSIZED));
      expect(echo.rawPayload.startsWith(ARGFILE_PREFIX)).toBe(true);
      expect(existsSync(echo.rawPayload.slice(ARGFILE_PREFIX.length))).toBe(false);
    } finally {
      child.kill();
      await child.wait();
    }
  }, 60_000);

  test("a payload at the inline limit is still passed inline, exactly as before", async () => {
    const inline = "y".repeat(ARGV_INLINE_MAX_BYTES);
    const result = await runGated(await gateRoot(), ECHO, ["inline", inline]);
    expect(result.code, result.stderr).toBe(0);
    const echo = JSON.parse(result.stdout.trim()) as Echo;
    expect(echo.rawPayload).toBe(inline.slice(0, 200));
    expect(echo.argvBytes[1]).toBe(ARGV_INLINE_MAX_BYTES);
    expect(echo.payloadSha256).toBe(sha256(inline));
  }, 60_000);
});

describe("argv guard: a direct spawn that Linux would refuse is refused everywhere, before spawning", () => {
  test("an argv string of exactly 131071 bytes runs; one byte more is refused with the reason", async () => {
    const atLimit = await runOwnedChild(process.execPath, ["-e", "process.exit(0)", "z".repeat(LINUX_MAX_ARG_STRING_BYTES)]);
    expect(atLimit.code, atLimit.stderr).toBe(0);

    let refused: unknown = null;
    try {
      await runOwnedChild(process.execPath, ["-e", "process.exit(0)", "z".repeat(LINUX_MAX_ARG_STRING_BYTES + 1)]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toContain("argv[3] is 131072 bytes");
    expect(String((refused as Error).message)).toContain("E2BIG");
  }, 60_000);

  test("an environment string over the limit is refused the same way", async () => {
    let refused: unknown = null;
    try {
      await runOwnedChild(process.execPath, ["-e", "process.exit(0)"], { env: { ARRA_ARGV_PROBE: "e".repeat(LINUX_MAX_ARG_STRING_BYTES) } });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toContain("env ARRA_ARGV_PROBE");
    expect(String((refused as Error).message)).toContain("E2BIG");
  }, 60_000);
});
