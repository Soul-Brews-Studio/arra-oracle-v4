// Ratchet Nat's style rule ("one exported function per file, named after the
// file", docs/overnight/DECISIONS.md, applied 2026-09-27): this test does NOT
// enforce the rule everywhere yet -- it freezes today's violators on an
// ALLOWLIST below and fails on anything NEW. The allowlist can only shrink:
// a file dropping below its listed count, or becoming fully compliant, must
// have its entry updated or removed in the SAME change, or this test fails.
//
// Sibling to file-size-cap.test.ts: same scan scope (git ls-files, not a
// filesystem walk), same "deliberately dumb" philosophy so it can't be fooled
// by reformatting, same exclusions (tests, node_modules, build output).
//
// What counts as an "exported function" (measured against the 2026-09-26
// f919369 driver's detector, and produces the SAME 706/39/8 split -- see the
// "measured today" test below):
//   - `export function NAME(...)`       (incl. `export async function`, `*`)
//   - `export default function NAME?(...)`  (anonymous default counts as one
//     export named "default")
//   - `export const NAME = (...) => ...`    (incl. `export const NAME = async (...) =>`,
//     with or without a type annotation between NAME and `=`)
// What does NOT count:
//   - `export { x } from "./mod"` and bare `export { x }` -- re-exports name
//     no new function in THIS file; neither matches any pattern above, so
//     they fall out for free rather than needing a special case.
//   - overload signatures: `export function foo(a: string): number;` followed
//     by its implementation share one name, and names are deduped with a
//     Set, so an overloaded export counts once, not once per signature.
//   - `export class`, `export interface`, `export type`, `export const` bound
//     to a non-arrow value (an object, a number, a `new Foo()`) -- none match
//     the arrow-function pattern.
//
// "Named after the file": Nat's own example is `service.listMessages.ts` ->
// `listMessages`, i.e. the LAST dot-segment of the filename stem, not the
// whole dotted stem. `policy.admit.ts` -> `admit` is compliant; `service.ts`
// -> `createOperationService` is not (no dot to take a segment from, and the
// name doesn't match the bare stem either).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");

const SCAN_ROOTS = [
  join("server", "src"),
  join("cli"),
  "cli.ts",
  join("ui", "v2", "src"),
];

const EXCLUDE_DIR_NAMES = new Set(["node_modules", "dist", "build", ".tmp", "test", "tests", "__tests__", "testing"]);

function isSourceFile(path: string): boolean {
  if (!/\.(ts|tsx)$/.test(path)) return false;
  if (/\.test\.(ts|tsx)$/.test(path)) return false;
  if (/\.spec\.ts$/.test(path)) return false;
  if (/\.d\.ts$/.test(path)) return false;
  if (path.split("/").some((segment) => EXCLUDE_DIR_NAMES.has(segment))) return false;
  return true;
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
    .sort();
}

function scan(): string[] {
  return SCAN_ROOTS.flatMap(trackedFiles);
}

/** Exported function-like names in one file's text, overloads deduped. */
function exportedFunctionNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*export\s+async\s+function\s*\*?\s+(\w+)/))) {
      names.push(m[1]!);
    } else if ((m = line.match(/^\s*export\s+function\s*\*?\s+(\w+)/))) {
      names.push(m[1]!);
    } else if ((m = line.match(/^\s*export\s+default\s+async\s+function\s*\*?\s*(\w*)/))) {
      names.push(m[1] || "default");
    } else if ((m = line.match(/^\s*export\s+default\s+function\s*\*?\s*(\w*)/))) {
      names.push(m[1] || "default");
    } else if ((m = line.match(/^\s*export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*async\s*\(/))) {
      names.push(m[1]!);
    } else if ((m = line.match(/^\s*export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*\(/))) {
      names.push(m[1]!);
    }
  }
  // Overloads (and any accidental duplicate line) count once per name.
  return [...new Set(names)];
}

/** The dot-segment a compliant single-export file's function must be named after. */
function expectedNames(relPath: string): string[] {
  const stem = basename(relPath).replace(/\.(ts|tsx)$/, "");
  const lastSegment = stem.split(".").pop()!;
  return [...new Set([stem, lastSegment])];
}

type FileReport = { path: string; names: string[] };

function measure(): FileReport[] {
  return scan()
    .map((relPath) => ({
      path: relPath,
      names: exportedFunctionNames(readFileSync(resolve(ROOT, relPath), "utf8")),
    }))
    .filter((r) => r.names.length > 0);
}

// --- ALLOWLIST -------------------------------------------------------------
// Every entry is a file that violates the rule TODAY (measured 2026-09-27 on
// v4/on-style-ratchet, base 9435719). This list may only shrink: removing an
// entry (because the file was split or renamed) is always fine; growing an
// entry's `count`, or leaving a now-compliant file listed, fails the test
// below on purpose -- see "the allowlist itself stays honest".

/** Files exporting MORE than one function, with today's exact count. */
const MULTI_EXPORT_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "server/src/contracts/common.ts": { count: 19, reason: "frozen contract validators (app/docs/contracts), shared by every kernel" },
  "ui/v2/src/api/evidenceReview.ts": { count: 18, reason: "UI api/*.ts domain-wrapper convention: one HTTP client module per domain" },
  "ui/v2/src/api/memory.ts": { count: 12, reason: "UI api/*.ts domain-wrapper convention: one HTTP client module per domain" },
  "ui/v2/src/api/knowledge.ts": { count: 11, reason: "UI api/*.ts domain-wrapper convention: one HTTP client module per domain" },
  "server/src/composition.ts": { count: 9, reason: "startup composition root; wires config/service/access checks, not independently reusable" },
  "server/src/contracts/evidence-v1.ts": { count: 9, reason: "frozen contract validators (app/docs/contracts/revision-evidence-v1.md), shared by every kernel" },
  "server/src/contracts/v1.ts": { count: 9, reason: "frozen contract validators (app/docs/contracts/v1-codecs.md), shared by every kernel" },
  "server/src/db.ts": { count: 9, reason: "single LanceDB table adapter; CRUD verbs on one table, cohesive by design" },
  "server/src/publication/rows.ts": { count: 8, reason: "row codec module: paired encode/decode + int64/timestamp helpers for one wire shape" },
  "server/src/auth/http.ts": { count: 7, reason: "HTTP transport helpers for one auth surface, read together" },
  "server/src/publication/chat.ts": { count: 7, reason: "frozen contract (app/docs/contracts/chat-v1.md) parse/project/render pipeline" },
  "server/src/publication/storage.ts": { count: 7, reason: "storage gate + row-decode helpers for one dataset boundary" },
  "server/src/knowledge/transport.ts": { count: 6, reason: "knowledge HTTP transport helpers for one surface" },
  "server/src/publication/lifecycle.ts": { count: 6, reason: "frozen contract (app/docs/contracts/lifecycle-v1.md) parse/encode pipeline" },
  "server/src/contracts/revision-v1.ts": { count: 5, reason: "frozen contract validators (app/docs/contracts/revision-publication-v1.md)" },
  "ui/v2/src/state/roster.ts": { count: 5, reason: "UI state/*.ts convention: paired load/save/mutate helpers for one client-side store" },
  "server/src/contracts/errors.ts": { count: 4, reason: "frozen contract error helpers, one error family shared by every kernel" },
  "server/src/mcp/calls.ts": { count: 4, reason: "mcp call-log audit helpers, one operational table" },
  "server/src/mcp/index.ts": { count: 4, reason: "MCP adapter composition root" },
  "server/src/mcp/protocol.ts": { count: 4, reason: "MCP JSON-RPC envelope helpers, one wire shape" },
  "server/src/publication/read-cursor.ts": { count: 4, reason: "frozen contract (app/docs/contracts/read-cursor-v1.md) parse/encode pipeline" },
  "server/src/embed.ts": { count: 3, reason: "embedding provider adapter: embed/embedOne/health for one provider" },
  "server/src/mcp/connections.ts": { count: 3, reason: "mcp connection-fold audit helpers, one operational table" },
  "server/src/publication/session-link.ts": { count: 3, reason: "frozen contract (app/docs/contracts/session-link-v1.md) parse/encode pipeline" },
  "ui/v2/src/api/audit.ts": { count: 3, reason: "UI api/*.ts domain-wrapper convention: one HTTP client module per domain" },
  "ui/v2/src/api/listing.ts": { count: 3, reason: "UI api/*.ts domain-wrapper convention: one HTTP client module per domain" },
  "ui/v2/src/api/overview.ts": { count: 3, reason: "UI api/*.ts domain-wrapper convention: one HTTP client module per domain" },
  "ui/v2/src/state/overviewDerive.ts": { count: 3, reason: "UI state/*.ts convention: paired pure derive helpers for one view" },
  "server/src/auth/policy.registry.ts": { count: 2, reason: "policy registry: register/lookup pair over one map" },
  "server/src/contracts/batch-v1.ts": { count: 2, reason: "frozen contract (app/docs/contracts/v1-codecs.md) dispatch/encode pair" },
  "server/src/contracts/replay-v1.ts": { count: 2, reason: "frozen contract replay-op pair, shared by source and revision replay" },
  "server/src/index.ts": { count: 2, reason: "process entrypoint: buildApp/startup pair" },
  "server/src/publication/errors.ts": { count: 2, reason: "publication error helpers, one error family" },
  "server/src/publication/service.constants.ts": { count: 2, reason: "publication scope/cursor-key constants, paired helpers" },
  "server/src/storage.ts": { count: 2, reason: "storage option/info pair for one dataset root" },
  "ui/v2/src/api/client.ts": { count: 2, reason: "UI api/*.ts domain-wrapper convention: callMethod/health transport pair" },
  "ui/v2/src/api/search.ts": { count: 2, reason: "UI api/*.ts domain-wrapper convention: keyword/semantic search pair" },
  "ui/v2/src/api/typeCount.ts": { count: 2, reason: "UI api/*.ts domain-wrapper convention: paired count/resolve helpers" },
  "ui/v2/src/overview/StatCard.tsx": { count: 2, reason: "React component + its co-located pure formatter" },
};

/** Files exporting exactly one function whose name does not follow "named after the file". */
const MISNAMED_ALLOWLIST: Record<string, { name: string; reason: string }> = {
  "server/src/app.ts": { name: "createApp", reason: "process-level entrypoint file, named for its role not a dotted convention" },
  "server/src/auth/loader.ts": { name: "loadPolicy", reason: "pre-dates the dotted naming convention; loader.ts holds the one policy loader" },
  "server/src/auth/service.ts": { name: "createOperationService", reason: "pre-dates the dotted naming convention; service.ts is the auth service factory" },
  "server/src/mcp/legacy-v3/chain.stopped.ts": { name: "chainStopped", reason: "dot-segment is the adjective 'stopped', not a callable verb naming mismatch is cosmetic" },
  "server/src/source/relic.errors.ts": { name: "failRelic", reason: "dot-segment is the plural 'errors', file holds relic's one error constructor" },
  "cli/kb.help.ts": { name: "kbHelpText", reason: "dot-segment is 'help', function is the concrete kbHelpText constant it returns" },
  "cli/kb.readRequestBody.ts": { name: "readKbRequestBody", reason: "function name carries a 'Kb' prefix the file's dot-segment omits" },
  "ui/v2/src/forum/threads.ts": { name: "buildThreads", reason: "pre-dates the dotted naming convention; threads.ts is the one thread builder" },
};

describe("one exported function per file (ratchet)", () => {
  test("measured today matches the frozen split (706 files export, 39 multi-export, 8 misnamed)", () => {
    const report = measure();
    // Sanity floor, same purpose as file-size-cap's: a scan that suddenly
    // finds far fewer files means the scan broke, not that the repo shrank.
    expect(report.length).toBeGreaterThanOrEqual(600);
    const multi = report.filter((r) => r.names.length > 1);
    const misnamed = report.filter((r) => {
      if (r.names.length !== 1) return false;
      const allowed = expectedNames(r.path);
      return !allowed.includes(r.names[0]!) && r.names[0] !== "default";
    });
    expect(multi.length).toBe(39);
    expect(misnamed.length).toBe(8);
  });

  test("no file outside the allowlist exports more than one function", () => {
    const offenders = measure()
      .filter((r) => r.names.length > 1)
      .filter((r) => !(r.path in MULTI_EXPORT_ALLOWLIST))
      .map((r) => `${r.path} (${r.names.length}: ${r.names.join(", ")})`);
    expect(offenders).toEqual([]);
  });

  test("no allowlisted multi-export file's count has grown", () => {
    const report = measure();
    const grown = Object.entries(MULTI_EXPORT_ALLOWLIST)
      .map(([path, entry]) => {
        const found = report.find((r) => r.path === path);
        const actual = found ? found.names.length : 0;
        return { path, allowed: entry.count, actual };
      })
      .filter(({ allowed, actual }) => actual > allowed)
      .map(({ path, allowed, actual }) => `${path}: allowlisted for ${allowed}, now ${actual}`);
    expect(grown).toEqual([]);
  });

  test("no allowlisted multi-export entry is stale (file already compliant)", () => {
    const report = measure();
    const stale = Object.entries(MULTI_EXPORT_ALLOWLIST)
      .filter(([path]) => {
        const found = report.find((r) => r.path === path);
        const actual = found ? found.names.length : 0;
        return actual <= 1;
      })
      .map(([path, entry]) => `${path}: allowlisted for ${entry.count}, now exports ${(report.find((r) => r.path === path)?.names.length) ?? 0} -- remove from MULTI_EXPORT_ALLOWLIST`);
    expect(stale).toEqual([]);
  });

  test("no file outside the allowlist has a single export misnamed for its file", () => {
    const offenders = measure()
      .filter((r) => r.names.length === 1)
      .filter((r) => {
        const allowed = expectedNames(r.path);
        return !allowed.includes(r.names[0]!) && r.names[0] !== "default";
      })
      .filter((r) => !(r.path in MISNAMED_ALLOWLIST))
      .map((r) => `${r.path} exports ${r.names[0]}, expected one of [${expectedNames(r.path).join(", ")}]`);
    expect(offenders).toEqual([]);
  });

  test("no allowlisted misnamed entry is stale (file already compliant)", () => {
    const report = measure();
    const stale = Object.entries(MISNAMED_ALLOWLIST)
      .filter(([path, entry]) => {
        const found = report.find((r) => r.path === path);
        if (!found || found.names.length !== 1) return true; // file split/removed/changed shape -- also stale
        const allowed = expectedNames(path);
        // Still exports the SAME allowlisted misnamed name -> not stale.
        return !(found.names[0] === entry.name && !allowed.includes(entry.name));
      })
      .map(([path]) => `${path}: allowlisted as misnamed, but is now compliant (or its shape changed) -- remove from MISNAMED_ALLOWLIST`);
    expect(stale).toEqual([]);
  });

  test("the allowlists themselves cover only files that exist and match their recorded shape", () => {
    const report = measure();
    const badMulti = Object.entries(MULTI_EXPORT_ALLOWLIST)
      .filter(([path]) => !report.some((r) => r.path === path))
      .map(([path]) => `${path}: listed in MULTI_EXPORT_ALLOWLIST but not found by the scan`);
    const badMisnamed = Object.entries(MISNAMED_ALLOWLIST)
      .filter(([path]) => !report.some((r) => r.path === path))
      .map(([path]) => `${path}: listed in MISNAMED_ALLOWLIST but not found by the scan`);
    expect([...badMulti, ...badMisnamed]).toEqual([]);
  });
});
