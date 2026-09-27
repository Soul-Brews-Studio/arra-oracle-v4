// style-server-split2 (#22): guards for the two splits kept from that slice
// -- auth/policy.registry.ts and mcp/connections.ts. Its session-link and
// read-cursor splits were refuted (helpers bundled into one exported object)
// and are not part of this change.
//
// Two things this file proves that the ratchet test does not:
//   1. Each barrel's re-exports are IDENTICAL to the split files' exports
//      (behaviour-preserving split, not just "the barrel compiles").
//   2. `policy.registry.state.ts`'s REGISTRY (verifier fix-round finding,
//      nonblocking) is imported only by its two intended sibling files --
//      restoring, by test rather than by convention, the encapsulation that
//      being merged into one file used to give it for free.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

function gitFiles(...args: string[]): string[] {
  return execFileSync("git", ["ls-files", ...args], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

describe("policy.registry.state.ts import boundary", () => {
  test("only its two sibling accessor files import it", () => {
    // Every tracked TS file under server/ and the CLI, from ANY directory and
    // in any import form (static, re-export, dynamic), not just ./ siblings.
    const files = gitFiles("server", "cli.ts", "cli").filter((f) => /\.tsx?$/.test(f));
    const importers = files.filter((f) => {
      if (f.endsWith("policy.registry.state.ts") || f.endsWith("style-split2-guard.test.ts")) return false;
      const text = readFileSync(join(ROOT, f), "utf8");
      return /(?:from|import\s*\()\s*["'][^"']*policy\.registry\.state(?:\.ts)?["']/.test(text);
    });
    expect(files.length).toBeGreaterThan(100);
    const allowed = new Set([
      "server/src/auth/policy.registry.registerPolicy.ts",
      "server/src/auth/policy.registry.lookupPolicy.ts",
    ]);
    for (const f of importers) {
      expect(allowed.has(f)).toBe(true);
    }
  });
});

describe("mcp/connections.ts barrel", () => {
  test("re-exports are identical to the split files' exports", async () => {
    const barrel = await import("../src/mcp/connections");
    const foldConnectionModule = await import("../src/mcp/connections.foldConnection");
    const failureCountModule = await import("../src/mcp/connections.connectionFoldFailureCount");
    const resetModule = await import("../src/mcp/connections.resetConnectionFoldState");
    expect(barrel.foldConnection).toBe(foldConnectionModule.foldConnection);
    expect(barrel.connectionFoldFailureCount).toBe(failureCountModule.connectionFoldFailureCount);
    expect(barrel.resetConnectionFoldState).toBe(resetModule.resetConnectionFoldState);
  });
});

