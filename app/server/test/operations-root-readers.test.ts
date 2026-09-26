// #103 / #102, DECISIONS.md R5: `mcp_calls` and `connections` are operations
// tables written straight to `ARRA_DATA_DIR` (`mcp/calls.ts`,
// `mcp/connections.ts`). The READERS (`mcp/calls.listMcpCalls.ts`,
// `mcp/connections.listConnections.ts`, wired in `knowledge/registry.ts`) now
// answer from that same root, on BOTH transports, with workspace isolation,
// pagination and `audit:read` authorization unchanged -- and the #102 fold no
// longer corrupts `connections` under concurrent writers.
//
// THIS FILE IS A THIN SPAWNER, deliberately. The actual scenarios live in
// `./fixtures/operations-root-v1/inner.ts`, run in ITS OWN `bun test`
// process. That split exists because of a fix-round finding (2026-09-26): a
// previous version of this file did all of its work in one `beforeAll`
// inside THIS file, which is discovered by every glob (`bun run test`,
// `test:full`, `test:parallel`) and therefore shares a process with whichever
// other test file Bun happens to load first. `ARRA_DATA_DIR` is a `const`
// read once at `storage.ts` import; four files (`transport-service`,
// `transport-ownership`, `knowledge-chat-transport`, `knowledge-chat-writer-
// gate`) statically import `../src/app` and therefore `storage.ts` too, so
// whichever of those Bun loads first freezes `DATA_DIR` for every later file
// in the process -- including this one's own `beforeAll`, which would then
// silently read and write the WRONG store (measured: a real `<checkout>/
// app/data` got opened during verification). `./fixtures/operations-root-v1/
// inner.ts` has no `.test.`/`.spec.` in its name, so no glob-based discovery
// (Bun's own directory scan, or `test.order.ts`'s recursive `*.test.ts` walk)
// ever finds it; the ONLY way it runs is the explicit `bun test <path>`
// invocation below, in a process that has never imported `../src/app` before
// and never will import anything else.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runOwnedChild } from "./helpers/publication-fixture";
import { testTimeout } from "./helpers/timing.testTimeout";
import { scaledMs } from "./helpers/timing.scaledMs";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const INNER = join(SERVER_DIR, "test", "fixtures", "operations-root-v1", "inner.ts");
const BARE_ROOT_PROBE = join(SERVER_DIR, "test", "fixtures", "operations-root-v1", "bare-root-probe.ts");

test("operations-root readers (#103 #102): isolated suite, own process", async () => {
  const result = await runOwnedChild(process.execPath, ["test", INNER], {
    cwd: SERVER_DIR,
    deadlineMs: scaledMs(120_000),
  });
  if (result.code !== 0) {
    throw new Error(
      `test/fixtures/operations-root-v1/inner.ts failed (exit ${result.code})\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
  expect(result.code).toBe(0);
  // Bun's own pass/fail summary line (printed to STDERR, not stdout), so a
  // shard that silently ran zero tests (e.g. a bad path) cannot read as
  // success just because exit was 0.
  expect(result.stderr).toMatch(/\d+ pass\b/);
  expect(result.stderr).not.toMatch(/[1-9]\d* fail\b/);
}, testTimeout(130_000));

/**
 * Nonblocking fix-round finding: an `ARRA_DATA_DIR` with NEITHER table used
 * to answer with the raw LanceDB SDK message (absolute dataset path
 * included), reaching an MCP client verbatim. Each probe is its OWN process
 * for the same module-caching reason as `inner.ts` above.
 */
for (const kind of ["calls", "connections"] as const) {
  test(`a bare ARRA_DATA_DIR (no ${kind === "calls" ? "mcp_calls" : "connections"} table) answers an empty page, never a raw SDK message`, async () => {
    const bareRoot = await mkdtemp(join(tmpdir(), `arra-v4-ops-root-bare-${kind}-`));
    try {
      const result = await runOwnedChild(process.execPath, [BARE_ROOT_PROBE, kind], {
        cwd: SERVER_DIR,
        env: { ...process.env, ARRA_DATA_DIR: bareRoot },
        deadlineMs: scaledMs(20_000),
      });
      if (result.code !== 0) {
        throw new Error(`bare-root-probe.ts (${kind}) failed (exit ${result.code})\n${result.stdout}\n${result.stderr}`);
      }
      const page = JSON.parse(result.stdout.trim());
      expect(page).toEqual({ rows: [], next_after_id: null, total: "0" });
      // The raw SDK text this used to leak names the dataset's path -- and
      // LanceDB prints it WITHOUT the leading slash ("Dataset at path
      // var/folders/..." on macOS), so checking the absolute path alone
      // would miss the very leak it exists to catch (fix-round finding).
      // The slashless form is a substring of the absolute one, so this one
      // check covers both spellings.
      expect(result.stdout).not.toContain(bareRoot.replace(/^\/+/, ""));
      expect(result.stdout).not.toMatch(/Dataset at path|was not found/);
    } finally {
      await rm(bareRoot, { recursive: true, force: true });
    }
  }, testTimeout(25_000));
}
