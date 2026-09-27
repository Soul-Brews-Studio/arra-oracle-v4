// Enforce Nat's 500-line cap on tracked TS/TSX source (docs/overnight/
// PLAN.md §1, 2026-09-26 21:00 entry: "one function per file, no file over
// 500 lines", applied by the 2026-09-27 py-split slice): behaviour-preserving
// moves only.
//
// Deliberately dumb (line count only) so it cannot be fooled by reformatting.
// Scans app/server/src, app/cli(.ts), app/ui/v2/src -- excludes tests,
// node_modules and build output. No documented exemptions: unlike the Python
// side's revision_v1.py, nothing here is pinned by a string-scanning guard.
//
// Scan is `git ls-files`, not a filesystem walk: untracked/generated .ts
// files under the scanned roots must not count toward the cap.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const LINE_CAP = 500;

const SCAN_ROOTS = [
  join("server", "src"),
  join("cli"),
  "cli.ts",
  join("ui", "v2", "src"),
];

const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "build", ".tmp", "test", "tests", "__tests__"]);

function isSourceFile(path: string): boolean {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.test\.(ts|tsx)$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  if (path.split("/").some((segment) => EXCLUDE_DIR_NAMES.has(segment))) return false;
  return true;
}

// wc -l / Python's splitlines() semantics: a trailing "\n" ends the last
// line, it does not start an empty one after it. `"a\nb\n".split("\n")`
// yields `["a", "b", ""]` (length 3) for a 2-line file; strip exactly one
// trailing newline first so a legal 500-line file is counted as 500, not 501.
function countLines(text: string): number {
  if (text.length === 0) return 0;
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").length;
}

function trackedFiles(root: string): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--", root], { cwd: ROOT, encoding: "utf8" });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return [];
    throw error;
  }
  return out
    .split("\0")
    .filter(Boolean)
    .filter(isSourceFile)
    .map((relative) => resolve(ROOT, relative));
}

function scan(): string[] {
  return SCAN_ROOTS.flatMap(trackedFiles);
}

describe("file size cap", () => {
  test("no tracked TS/TSX source file exceeds the line cap", () => {
    const files = scan();
    expect(files.length).toBeGreaterThanOrEqual(30);
    const offenders = files
      .map((path) => ({ path, lines: countLines(readFileSync(path, "utf8")) }))
      .filter(({ lines }) => lines > LINE_CAP);
    expect(offenders).toEqual([]);
  });
});
