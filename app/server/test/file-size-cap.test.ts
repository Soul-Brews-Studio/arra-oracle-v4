// Enforce Nat's 500-line cap on tracked TS/TSX source (docs/overnight/
// DECISIONS.md + PLAN.md, 2026-09-26/27 py-split slice): "one function per
// file, no file over 500 lines", behaviour-preserving moves only.
//
// Deliberately dumb (line count only) so it cannot be fooled by reformatting.
// Scans app/server/src, app/cli(.ts), app/ui/v2/src -- excludes tests,
// node_modules and build output. No documented exemptions: unlike the Python
// side's revision_v1.py, nothing here is pinned by a string-scanning guard.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const LINE_CAP = 500;

const SCAN_ROOTS = [
  join(ROOT, "server", "src"),
  join(ROOT, "cli"),
  join(ROOT, "cli.ts"),
  join(ROOT, "ui", "v2", "src"),
];

const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "build", ".tmp", "test", "tests", "__tests__"]);

function isSourceFile(path: string): boolean {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.test\.(ts|tsx)$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  return true;
}

function walk(path: string, out: string[]): void {
  const stat = statSync(path);
  if (stat.isFile()) {
    if (isSourceFile(path)) out.push(path);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (EXCLUDE_DIR_NAMES.has(entry)) continue;
    walk(join(path, entry), out);
  }
}

function scan(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      walk(root, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

describe("file size cap", () => {
  test("no tracked TS/TSX source file exceeds the line cap", () => {
    const files = scan();
    expect(files.length).toBeGreaterThanOrEqual(30);
    const offenders = files
      .map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n").length }))
      .filter(({ lines }) => lines > LINE_CAP);
    expect(offenders).toEqual([]);
  });
});
