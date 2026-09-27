// Ratchet Nat's style rule ("one exported function per file, named after the
// file" -- docs/overnight/PLAN.md:40 sets "one function per file"; the "named
// after the file" wording is app/docs/contracts/lifecycle-v1.md:308 and
// app/docs/contracts/target-v1-decisions.md:122. docs/overnight/DECISIONS.md
// does not state this rule itself, only adjacent decisions). This test does
// NOT enforce the rule everywhere yet -- it freezes today's violators on an
// ALLOWLIST below and fails on anything NEW. The allowlist can only shrink:
// a file dropping below its listed count (still multi-export, or now fully
// compliant) must have its entry updated or removed in the SAME change, or
// this test fails -- see "no allowlisted ... entry is stale" below.
//
// Sibling to file-size-cap.test.ts: same scan scope philosophy (git
// ls-files, not a filesystem walk) and same exclusions (tests, node_modules,
// build output). Two consequences worth knowing, shared with that sibling:
// (1) a brand-new file is invisible to `git ls-files` until it is at least
// `git add -N`-ed -- a local run against a purely untracked new file will
// not see it (CI/pre-commit runs against staged/committed trees, so this
// does not hide anything there). (2) the scan roots below (server/src,
// cli(.ts), ui/v2/src) are the same three Nat's style pass covered -- they
// deliberately do NOT include ui/v1/src, ui/v3/src, ui/v2/vite.config.ts,
// benchmarks/run_lance.ts, or this package's own test.order.ts/
// test.parallel.ts. The rule is not ratcheted there yet.
//
// What counts as an "exported function", and how it's detected: this is a
// two-step scan, not a line-regex (a bare line-regex is what a fix round
// found could be defeated by `export { localFn }`, an arrow with a return
// type between the params and `=>`, a generic function name, a reformatted
// multi-line arrow, `let`/`var` instead of `const`, or an anonymous default
// arrow -- see exportedFunctionNames below for the enumerated forms this
// now handles).
//   1. `Bun.Transpiler().scan(text).exports` (built into Bun, no new
//      dependency) gives the AUTHORITATIVE list of names this file exports,
//      for every export form TS has -- function/const/let/var, default,
//      `export { a, b }`, overloads deduped to one name each, re-exports.
//      This step can't be fooled by reformatting because it's a real
//      parse, not a regex over lines.
//   2. For each exported name, isFunctionDeclared/isDefaultFunction search
//      the file's full text for a LOCAL declaration of that name shaped
//      like a function: `function NAME(...)` (incl. `async`, `*`, and a
//      generic `<T>` before the parens), or `const|let|var NAME = ...`
//      bound to a `function` expression or an arrow (incl. `async`,
//      generics before the params, a single bare-identifier param with no
//      parens, and a return-type annotation between the params and `=>`).
//      A name that step 1 lists but step 2 finds no local function
//      declaration for -- a re-export of an import (`export { x } from
//      "./mod"`, or `import {x} ...; export {x};`), a class, an
//      interface/type (step 1 already excludes pure type exports), or a
//      plain-value const -- does NOT count. This is what makes
//      `export { localHelper }` count when localHelper is a function
//      declared in THIS file, but not when it's imported from elsewhere:
//      step 2 only finds a match if the function is actually declared
//      here, regardless of which export syntax names it.
//   - overload signatures share one name and names are deduped with a Set,
//     so an overloaded export counts once, not once per signature.
//   - `export class`, `export interface`, `export type`, and a `const`
//     bound to a non-function value (object, number, `new Foo()`) match
//     neither step 2 pattern, so they don't count. A class whose method
//     happens to share the class's own name is not mistaken for a
//     top-level function export (step 2 requires `function`/arrow/`const`
//     binding syntax, not a class body).
//   - Known gap, not exercised by any file today: an anonymous
//     `export default function () {}` or `export default (x) => x` always
//     counts as compliant (there's no name to check), whatever the
//     filename claims to hold. `.spec.tsx` is not excluded (no such files
//     exist in-tree).
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

// A bare `export { x }` or `export { x } from "./mod"` names no NEW
// function in THIS file when x is a re-export of an import -- step 2 below
// already excludes those (no local declaration to find), but this explicit
// list is kept as defense-in-depth documentation of intent, not load-bearing
// for correctness.
const RE_EXPORT_FROM = /export\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/g;

function reExportedFromElsewhere(text: string): Set<string> {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  RE_EXPORT_FROM.lastIndex = 0;
  while ((m = RE_EXPORT_FROM.exec(text))) {
    for (const raw of m[1]!.split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const local = part.replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (local) names.add(local);
    }
  }
  return names;
}

function escapeForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An arrow function's head, starting right after the `=`: optional `async`,
// optional generics (`<T,>`), then either a parenthesized param list or a
// single bare identifier, then an optional return-type annotation, then
// `=>`. Bounded (not `[\s\S]*`) so a failed match on a non-function value
// can't skip forward across a `;` into an unrelated later declaration.
const ARROW_HEAD =
  "(?:async\\s*)?(?:<[^;]{0,150}?>\\s*)?(?:\\([^;]{0,1200}?\\)|[A-Za-z_$][\\w$]*)(?:\\s*:\\s*[^;]{0,300}?)?\\s*=>";

// Identifier boundaries that also work for non-ASCII names (`ทดสอบ`, `debug$`):
// `\\b` only knows ASCII word characters.
const ID_BEFORE = "(?<![\\p{L}\\p{N}_$])";
const ID_AFTER = "(?![\\p{L}\\p{N}_$])";

/** Does the TYPE-STRIPPED `js` declare NAME locally as a function, a function
 *  expression, or an arrow? Classifying after `transformSync` means generics,
 *  parameter and return annotations (which may contain `;`, `>` or `=>`) are
 *  gone, so `<T extends Array<string>>` or `(o: { a: number; b: string })`
 *  cannot hide a function (wave-13 verifier forms c, d, e). */
function isFunctionDeclared(js: string, name: string): boolean {
  const esc = escapeForRegex(name);
  const declaration = new RegExp(`${ID_BEFORE}function\\s*\\*?\\s*${esc}${ID_AFTER}\\s*\\(`, "u");
  if (declaration.test(js)) return true;
  // A binding either right after const/let/var, or a later declarator in the
  // same statement (`export const a = () => 1, b = () => 2`).
  const value = `\\s*=(?!>)\\s*(?:async\\s+)?(?:function\\b|${ARROW_HEAD})`;
  const binding = new RegExp(`(?:\\b(?:const|let|var)\\s+|,\\s*)${esc}${ID_AFTER}${value}`, "u");
  return binding.test(js);
}

// `export { local as alias, other }` with NO `from`: map each exported name
// back to the local it names, so an aliased local function counts (form b).
const LOCAL_EXPORT_LIST = /export\s*\{([^}]*)\}(?!\s*from)/g;

function localNameFor(js: string): Map<string, string> {
  const map = new Map<string, string>();
  let m: RegExpExecArray | null;
  LOCAL_EXPORT_LIST.lastIndex = 0;
  while ((m = LOCAL_EXPORT_LIST.exec(js))) {
    for (const raw of m[1]!.split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const [local, alias] = part.split(/\s+as\s+/).map((x) => x.trim());
      if (local) map.set(alias || local, local);
    }
  }
  return map;
}

/** Is `export default ...` in `text` a function, function expression, or arrow? */
function isDefaultFunction(text: string): boolean {
  if (/export\s+default\s+(?:async\s+)?function\b/.test(text)) return true;
  return new RegExp(`export\\s+default\\s+${ARROW_HEAD}`).test(text);
}

function loaderFor(relPath: string): "ts" | "tsx" {
  return relPath.endsWith(".tsx") ? "tsx" : "ts";
}

/** Exported function-like names in one file's text, overloads deduped. */
function exportedFunctionNames(text: string, relPath: string): string[] {
  const transpiler = new Bun.Transpiler({ loader: loaderFor(relPath) });
  // Fail loudly: a file the scanner cannot parse must not silently count as
  // exporting nothing (wave-13 verifier, non-blocking).
  const scanned = transpiler.scan(text);
  const js = transpiler.transformSync(text);
  const excluded = reExportedFromElsewhere(text);
  const locals = localNameFor(js);
  const names: string[] = [];
  for (const name of scanned.exports) {
    if (excluded.has(name)) continue;
    if (name === "default") {
      if (isDefaultFunction(js)) names.push("default");
      continue;
    }
    if (isFunctionDeclared(js, locals.get(name) ?? name)) names.push(name);
  }
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
      names: exportedFunctionNames(readFileSync(resolve(ROOT, relPath), "utf8"), relPath),
    }))
    .filter((r) => r.names.length > 0);
}

// --- ALLOWLIST -------------------------------------------------------------
// Every entry is a file that violates the rule TODAY (measured 2026-09-27 on
// v4/on-style-ratchet, base 9435719, with the two-step scan/classify
// detector above -- reproduces the driver's 706/39/8 split exactly). This
// list may only shrink: removing an entry (because the file was split or
// renamed) is always fine; growing an entry's `count`, or leaving a now-
// lower or now-compliant file listed at its old count, fails the test below
// on purpose -- see "the allowlist itself stays honest".

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
  test("measured today matches the allowlist-sized multi/misnamed split", () => {
    const report = measure();
    // Sanity floor, same purpose as file-size-cap's: a scan that suddenly
    // finds far fewer files means the scan broke, not that the repo shrank.
    expect(report.length).toBeGreaterThanOrEqual(600);
    // No exact total: adding or deleting a COMPLIANT file must never fail a
    // ratchet (the wave-13 verifier's finding; 706 on 9435719 is recorded in
    // the header, not asserted).
    const multi = report.filter((r) => r.names.length > 1);
    const misnamed = report.filter((r) => {
      if (r.names.length !== 1) return false;
      const allowed = expectedNames(r.path);
      return !allowed.includes(r.names[0]!) && r.names[0] !== "default";
    });
    // Derived from the allowlists themselves (not repeated as separate
    // literals) so this assertion can't silently drift from them.
    expect(multi.length).toBe(Object.keys(MULTI_EXPORT_ALLOWLIST).length);
    expect(misnamed.length).toBe(Object.keys(MISNAMED_ALLOWLIST).length);
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

  test("no allowlisted multi-export entry is stale (count dropped, or file is now compliant)", () => {
    const report = measure();
    // `actual < entry.count`, not `actual <= 1`: a count that drops but
    // stays multi-export (19 -> 18) must ALSO force the entry to be
    // updated, not just a drop to full compliance. Freezing the ceiling at
    // the old high-water mark would let the count wander back up to it
    // later without ever tripping the "grown" test above, since that test
    // only compares against this (stale) `entry.count`.
    const stale = Object.entries(MULTI_EXPORT_ALLOWLIST)
      .map(([path, entry]) => {
        const found = report.find((r) => r.path === path);
        const actual = found ? found.names.length : 0;
        return { path, entry, actual };
      })
      .filter(({ entry, actual }) => actual < entry.count)
      .map(({ path, entry, actual }) => `${path}: allowlisted for ${entry.count}, now exports ${actual} -- update its count in MULTI_EXPORT_ALLOWLIST (or remove the entry if actual <= 1)`);
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
