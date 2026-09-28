// style-server-split4a (#22): guards for this slice's three barrels --
// db.ts, auth/http.ts, publication/storage.ts. Fix round for a verifier
// finding: no barrel-identity guard existed (unlike style-split2-guard.test.ts
// for mcp/connections.ts), and db.state.ts's shared mutable singleton has no
// import boundary (unlike policy.registry.state.ts's).
//
// Two things this file proves that the ratchet test does not:
//   1. Each barrel's re-exports are IDENTICAL to the split files' exports
//      (behaviour-preserving split, not just "the barrel compiles").
//   2. `db.state.ts`'s shared `conn`/`table` singleton is imported only by
//      the split files that need it today -- restoring, by test rather than
//      by convention, the encapsulation the old single-file db.ts gave it
//      for free.

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

describe("db.state.ts import boundary", () => {
  test("only its two current consumers import it", () => {
    const files = gitFiles("server", "cli.ts", "cli").filter((f) => /\.tsx?$/.test(f));
    const importers = files.filter((f) => {
      if (f.endsWith("db.state.ts") || f.endsWith("style-split4a-guard.test.ts")) return false;
      const text = readFileSync(join(ROOT, f), "utf8");
      return /(?:from|import\s*\()\s*["'][^"']*db\.state(?:\.ts)?["']/.test(text);
    });
    expect(files.length).toBeGreaterThan(100);
    const allowed = new Set(["server/src/db.db.ts", "server/src/db.stats.ts"]);
    for (const f of importers) {
      expect(allowed.has(f)).toBe(true);
    }
  });
});

describe("db.ts barrel", () => {
  test("re-exports are identical to the split files' exports", async () => {
    const barrel = await import("../src/db");
    const dbModule = await import("../src/db.db");
    const insertModule = await import("../src/db.insert");
    const ensureFtsIndexModule = await import("../src/db.ensureFtsIndex");
    const searchTextModule = await import("../src/db.searchText");
    const searchVectorModule = await import("../src/db.searchVector");
    const listModule = await import("../src/db.list");
    const getByIdModule = await import("../src/db.getById");
    const backfillModule = await import("../src/db.backfill");
    const statsModule = await import("../src/db.stats");
    expect(barrel.db).toBe(dbModule.db);
    expect(barrel.insert).toBe(insertModule.insert);
    expect(barrel.ensureFtsIndex).toBe(ensureFtsIndexModule.ensureFtsIndex);
    expect(barrel.searchText).toBe(searchTextModule.searchText);
    expect(barrel.searchVector).toBe(searchVectorModule.searchVector);
    expect(barrel.list).toBe(listModule.list);
    expect(barrel.getById).toBe(getByIdModule.getById);
    expect(barrel.backfill).toBe(backfillModule.backfill);
    expect(barrel.stats).toBe(statsModule.stats);
  });
});

describe("auth/http.ts barrel", () => {
  test("re-exports are identical to the split files' exports", async () => {
    const barrel = await import("../src/auth/http");
    const typesModule = await import("../src/auth/http.types");
    const readBoundedBodyModule = await import("../src/auth/http.readBoundedBody");
    const readAuthorizationModule = await import("../src/auth/http.readAuthorization");
    const checkHostAndOriginModule = await import("../src/auth/http.checkHostAndOrigin");
    const checkBodyEncodingModule = await import("../src/auth/http.checkBodyEncoding");
    const isValidWorkspaceModule = await import("../src/auth/http.isValidWorkspace");
    const isRejectionModule = await import("../src/auth/http.isRejection");
    const errorResponseModule = await import("../src/auth/http.errorResponse");
    expect(barrel.ERROR_BODIES).toBe(typesModule.ERROR_BODIES);
    expect(barrel.MAX_BODY_BYTES).toBe(readBoundedBodyModule.MAX_BODY_BYTES);
    expect(barrel.readBoundedBody).toBe(readBoundedBodyModule.readBoundedBody);
    expect(barrel.readAuthorization).toBe(readAuthorizationModule.readAuthorization);
    expect(barrel.checkHostAndOrigin).toBe(checkHostAndOriginModule.checkHostAndOrigin);
    expect(barrel.checkBodyEncoding).toBe(checkBodyEncodingModule.checkBodyEncoding);
    expect(barrel.isValidWorkspace).toBe(isValidWorkspaceModule.isValidWorkspace);
    expect(barrel.isRejection).toBe(isRejectionModule.isRejection);
    expect(barrel.errorResponse).toBe(errorResponseModule.errorResponse);
  });
});

describe("publication/storage.ts barrel", () => {
  test("re-exports are identical to the split files' exports", async () => {
    const barrel = await import("../src/publication/storage");
    const assertInheritedGateModule = await import("../src/publication/storage.assertInheritedGate");
    const schemaModule = await import("../src/publication/storage.schema");
    const assertLocalDatasetRootModule = await import("../src/publication/storage.assertLocalDatasetRoot");
    const describeFieldModule = await import("../src/publication/storage.describeField");
    const assertTargetDatasetModule = await import("../src/publication/storage.assertTargetDataset");
    const quoteModule = await import("../src/publication/storage.quote");
    const decodeArrowRowsModule = await import("../src/publication/storage.decodeArrowRows");
    const rawRowsModule = await import("../src/publication/storage.rawRows");
    expect(barrel.LOCK_FILENAME).toBe(assertInheritedGateModule.LOCK_FILENAME);
    expect(barrel.INHERITED_FD).toBe(assertInheritedGateModule.INHERITED_FD);
    expect(barrel.assertInheritedGate).toBe(assertInheritedGateModule.assertInheritedGate);
    expect(barrel.TARGET_SCHEMA).toBe(schemaModule.TARGET_SCHEMA);
    expect(barrel.TARGET_TABLES).toBe(schemaModule.TARGET_TABLES);
    expect(barrel.assertLocalDatasetRoot).toBe(assertLocalDatasetRootModule.assertLocalDatasetRoot);
    expect(barrel.describeField).toBe(describeFieldModule.describeField);
    expect(barrel.assertTargetDataset).toBe(assertTargetDatasetModule.assertTargetDataset);
    expect(barrel.quote).toBe(quoteModule.quote);
    expect(barrel.decodeArrowRows).toBe(decodeArrowRowsModule.decodeArrowRows);
    expect(barrel.rawRows).toBe(rawRowsModule.rawRows);
  });
});
