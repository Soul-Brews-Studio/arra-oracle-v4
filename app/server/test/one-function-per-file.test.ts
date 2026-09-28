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
// What counts as an "exported function", and how it's detected: TypeScript's
// own parser (the compiler API from app/ui/v2's installed `typescript`; see
// loadTypeScript below). exportedFunctionNames walks the top-level statements
// of the syntax tree, so nothing inside a string, template, regex, comment,
// parameter default or nested scope can hide or invent an export. Counted:
// `export function f` (overloads once), `export const|let|var f = <arrow or
// function expression>` (every declarator; a conditional whose branches are
// both functions counts), `export declare function f` (ambient, counted: the
// strict choice), `export default function name` / `export default local` /
// `export { local as default }` (all under the function's own name, so the
// naming check sees them), `export default <anonymous function>` (as
// "default"), and `export { local }` of a function declared here.
// Not counted: re-exports `export { x } from "./m"`, classes, interfaces,
// types, enums, plain values, and call results (an IIFE, `memo(fn)`).
//   - Known gaps, not exercised by any file today: an ANONYMOUS
//     `export default function () {}` or `export default (x) => x` counts as
//     compliant (there is no name to check); `export let f: T; f = () => ...`
//     (assigned after declaration) does not count. `.spec.tsx` is not excluded
//     (no such files exist in-tree).
//   - The parser comes from app/ui/v2 and must stay TypeScript 5.x: the
//     `typescript@7` CI installs for the server's own typecheck is the native
//     compiler and exposes no `createSourceFile`.
//   - History: verify rounds 2-6 attacked a hand-written lexer and found a new
//     evasion each time; DETECTOR_CASES at the bottom pins every one of those
//     forms against the names TypeScript reports, so the parser swap is
//     checked against all of them.
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

// THE DETECTOR IS TYPESCRIPT'S OWN PARSER (round 7). Six verify rounds on a
// hand-written lexer (regex vs division, templates, keywords as property
// names: `obj.default / n`) each closed one evasion and opened another. The
// compiler API is the ground truth every verifier measured against, so it is
// now the detector itself: no lexer, nothing to evade. It is NOT a new
// dependency of app/server: it is app/ui/v2's own `typescript`, which CI
// installs (`bun install` in app/ui/v2) before this suite runs, and this test
// already scans app/ui/v2/src. If it is missing, the test fails loudly.
function loadTypeScript(): any {
  const path = join(ROOT, "ui", "v2", "node_modules", "typescript");
  try {
    return require(path);
  } catch (error) {
    throw new Error(
      `one-function-per-file needs TypeScript's parser from app/ui/v2 (run \`bun install --frozen-lockfile\` in app/ui/v2): ${String(error)}`,
    );
  }
}
const ts = loadTypeScript();

/** Strip wrappers that do not change what a value IS: parens, `as`,
 *  `satisfies`, `<T>x`, `x!`. A call (IIFE, `memo(fn)`) is NOT stripped: its
 *  result is not a function declaration in this file. */
function unwrap(e: any): any {
  while (
    e &&
    (ts.isParenthesizedExpression(e) ||
      ts.isAsExpression(e) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(e)) ||
      ts.isTypeAssertionExpression(e) ||
      ts.isNonNullExpression(e))
  ) {
    e = e.expression;
  }
  return e;
}

function isFunctionValue(e: any): boolean {
  const v = unwrap(e);
  if (!v) return false;
  // `cond ? () => 1 : () => 2` is a function whichever branch runs.
  if (ts.isConditionalExpression(v)) return isFunctionValue(v.whenTrue) && isFunctionValue(v.whenFalse);
  return ts.isArrowFunction(v) || ts.isFunctionExpression(v);
}

/** Exported function names in one file, from TypeScript's syntax tree:
 *  - `export function f` / `export async function* f` (overloads count once);
 *  - `export default function ...` and `export default <arrow|function expr>`
 *    count as "default" (no name to check);
 *  - `export const|let|var f = <arrow|function expression>` (also later
 *    declarators in the same statement);
 *  - `export default local` and `export { local as default }` count under the
 *    LOCAL function's name, so the naming check sees it;
 *  - `export { local }` / `export { local as alias }` of a function declared
 *    in THIS file count (under the exported name).
 *  A re-export `export { x } from "./m"`, classes, interfaces, types, enums,
 *  plain values and call results do not count. */
function exportedFunctionNames(text: string, relPath: string): string[] {
  const kind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const flags = (n: any): number => ts.getCombinedModifierFlags(n);
  const isExported = (n: any) => (flags(n) & ts.ModifierFlags.Export) !== 0;
  const isDefault = (n: any) => (flags(n) & ts.ModifierFlags.Default) !== 0;
  const localFunctions = new Set<string>();
  const names: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st)) {
      if (st.name) localFunctions.add(st.name.text);
      // A NAMED default function is checked under its name, exactly like
      // `function helper(){}; export default helper;` (round-7 verifier).
      if (isExported(st)) names.push(st.name ? st.name.text : "default");
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isFunctionValue(d.initializer)) {
          localFunctions.add(d.name.text);
          if (isExported(st)) names.push(d.name.text);
        }
      }
    }
  }
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && !st.isExportEquals) {
      if (isFunctionValue(st.expression)) names.push("default");
      else if (ts.isIdentifier(st.expression) && localFunctions.has(st.expression.text)) names.push(st.expression.text);
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (localFunctions.has(local)) names.push(el.name.text === "default" ? local : el.name.text);
      }
    }
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
// detector's first version, and re-measured with the TypeScript-parser
// detector below: the same 706/39/8 split). This
// list may only shrink: removing an entry (because the file was split or
// renamed) is always fine; growing an entry's `count`, or leaving a now-
// lower or now-compliant file listed at its old count, fails the test below
// on purpose -- see "the allowlist itself stays honest".

/** Files exporting MORE than one function, with today's exact count. */
const MULTI_EXPORT_ALLOWLIST: Record<string, { count: number; reason: string }> = {
  "server/src/publication/read-cursor.ts": { count: 4, reason: "frozen contract (app/docs/contracts/read-cursor-v1.md) parse/encode pipeline" },
  "server/src/publication/session-link.ts": { count: 3, reason: "frozen contract (app/docs/contracts/session-link-v1.md) parse/encode pipeline" },
  "server/src/contracts/common.ts": { count: 19, reason: "frozen contract validators (app/docs/contracts), shared by every kernel" },
  "server/src/composition.ts": { count: 10, reason: "startup composition root; wires config/service/access checks, not independently reusable (#31 maint-audit added composeInstanceAuditSink)" },
  "server/src/contracts/evidence-v1.ts": { count: 9, reason: "frozen contract validators (app/docs/contracts/revision-evidence-v1.md), shared by every kernel" },
  "server/src/contracts/v1.ts": { count: 9, reason: "frozen contract validators (app/docs/contracts/v1-codecs.md), shared by every kernel" },
  "server/src/publication/chat.ts": { count: 7, reason: "frozen contract (app/docs/contracts/chat-v1.md) parse/project/render pipeline" },
  "server/src/knowledge/transport.ts": { count: 6, reason: "knowledge HTTP transport helpers for one surface" },
  "server/src/contracts/revision-v1.ts": { count: 5, reason: "frozen contract validators (app/docs/contracts/revision-publication-v1.md)" },
  "server/src/contracts/errors.ts": { count: 4, reason: "frozen contract error helpers, one error family shared by every kernel" },
  "server/src/mcp/calls.ts": { count: 6, reason: "mcp call-log audit helpers, one operational table (#31 maint-audit exported redact/truncate for the instance-level sink to reuse, not re-derive, R5)" },
  "server/src/mcp/index.ts": { count: 4, reason: "MCP adapter composition root" },
  "server/src/mcp/protocol.ts": { count: 4, reason: "MCP JSON-RPC envelope helpers, one wire shape" },
  "server/src/contracts/batch-v1.ts": { count: 2, reason: "frozen contract (app/docs/contracts/v1-codecs.md) dispatch/encode pair" },
  "server/src/contracts/replay-v1.ts": { count: 2, reason: "frozen contract replay-op pair, shared by source and revision replay" },
};

/** Files exporting exactly one function whose name does not follow "named after the file".
 *  Was 8 entries (measured 2026-09-27, see MULTI_EXPORT_ALLOWLIST's header note for the
 *  706/39/8 baseline split). Style-shrink (2026-09-28, docs/overnight/DECISIONS.md,
 *  slice style-shrink) renamed all 8 -- each `git mv` to `<stem>.<functionName>.ts`,
 *  keeping the function name (and every call site) unchanged, which is why every rename
 *  here is a file move, not a function rename: server/src/app.ts -> app.createApp.ts,
 *  auth/loader.ts -> loader.loadPolicy.ts, auth/service.ts -> service.createOperationService.ts,
 *  mcp/legacy-v3/chain.stopped.ts -> chain.chainStopped.ts, source/relic.errors.ts ->
 *  relic.failRelic.ts, cli/kb.help.ts -> kb.kbHelpText.ts, cli/kb.readRequestBody.ts ->
 *  kb.readKbRequestBody.ts, ui/v2/src/forum/threads.ts -> threads.buildThreads.ts. The
 *  allowlist is empty now, not removed, so a future misnamed single-export file still has
 *  somewhere to be listed. */
const MISNAMED_ALLOWLIST: Record<string, { name: string; reason: string }> = {};

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

// Every attack form the independent verifiers found in rounds 2-7, with the
// names TypeScript's own parser reports for it (computed with the TypeScript
// compiler API as ground truth, then frozen here). The detector must agree on
// each: a regression here means a real violation could pass the ratchet green
// or a compliant file could go red. Paths are synthetic (only the extension
// matters to the detector).
const DETECTOR_CASES: { title: string; path: string; src: string; expected: string[] }[] = [
  { title: "r2 async function expression", path: "server/src/x/p.admit.ts", src: "export const debugA = async function () { return 1; };\nexport function admit() { return 0; }\n", expected: ["admit", "debugA"] },
  { title: "r2 aliased local", path: "server/src/x/p.debugAlias.ts", src: "function debugHelper() { return 2; }\nexport { debugHelper as debugAlias };\n", expected: ["debugAlias"] },
  { title: "r2 nested generics", path: "server/src/x/p.debugG.ts", src: "export function debugG<T extends Array<string>>(x: T) { return x.length; }\n", expected: ["debugG"] },
  { title: "r2 object-type param with ;", path: "server/src/x/p.debugO.ts", src: "export const debugO = (opts: { a: number; b: string }) => opts.a;\n", expected: ["debugO"] },
  { title: "r2 return-type literal with ;", path: "server/src/x/p.debugR.ts", src: "export const debugR = (x: number): { a: number; b: number } => ({ a: x, b: x });\n", expected: ["debugR"] },
  { title: "r2 unicode and $ names", path: "server/src/x/p.u.ts", src: "export const ทดสอบ = () => 1;\nexport const debug$ = () => 1;\n", expected: ["debug$", "ทดสอบ"] },
  { title: "r2 multiple declarators", path: "server/src/x/p.m.ts", src: "export const debugM1 = () => 1, debugM2 = () => 2;\n", expected: ["debugM1", "debugM2"] },
  { title: "r3 default names a local", path: "server/src/x/p.sneakyA.ts", src: "export function sneakyA() { return 1; }\nfunction helper() { return 2; }\nexport default helper;\n", expected: ["helper", "sneakyA"] },
  { title: "r3 local aliased as default", path: "server/src/x/p.sneakyB.ts", src: "function sneakyB() { return 1; }\nfunction helper() { return 2; }\nexport { helper as default, sneakyB };\n", expected: ["helper", "sneakyB"] },
  { title: "r3 ; in string, regex and function-body defaults", path: "server/src/x/p.splitRow.ts", src: "export const splitRow = (row: string, sep = \";\") => row.split(sep);\nexport const joinRow = (cells: string[], sep = /;/g.source) => cells.join(sep);\nexport const other = (cb = function () { return 1; }) => cb();\n", expected: ["joinRow", "other", "splitRow"] },
  { title: "r3 export-from text in a comment", path: "server/src/x/p.sneakyD.ts", src: "/** Moved here from: export { sneakyD, helperD } from \"./policy.sneakyD\"; */\nexport function sneakyD() { return 1; }\nexport function helperD() { return 2; }\n", expected: ["helperD", "sneakyD"] },
  { title: "r4 template holding } in a code generator", path: "server/src/x/p.zzCodegen.ts", src: "export const zzCodegen = (keys: string[]) => `{${keys.map((k, i) => `\"${k}\": 1${i === keys.length - 1 ? `}` : `,`}`).join(\"\")}`;\nexport function secondGen(): string { return \"x\"; }\n", expected: ["secondGen", "zzCodegen"] },
  { title: "r4 template brace", path: "server/src/x/p.zzTemplateBrace.ts", src: "export const zzTemplateBrace = (last: boolean) => `${last ? `}` : `},`}`;\nexport const zzSecond = () => 2;\n", expected: ["zzSecond", "zzTemplateBrace"] },
  { title: "r4 block arrow in template exposing /*", path: "server/src/x/p.zzTemplateObj.ts", src: "export const zzTemplateObj = (xs: string[]) => `${xs.map((x) => { return x; }).join(`/*`)}`;\nexport const zzThird = () => 3;\n", expected: ["zzTemplateObj", "zzThird"] },
  { title: "r4 function IIFEs are results", path: "server/src/x/p.zzIife.ts", src: "export const x = function () { return 1; }();\nexport const y = (function () { return 1; })();\nexport function zzIife() { return 3; }\n", expected: ["zzIife"] },
  { title: "r4 parameter default shadowing an export", path: "server/src/x/p.zzParamDefault.ts", src: "export const now = 0;\nexport function zzParamDefault(x: number, now = () => Date.now()) { return x + now(); }\n", expected: ["zzParamDefault"] },
  { title: "r5 regex after if-condition holding (", path: "server/src/x/p.atk04b.ts", src: "export function atk04b(y: string): number {\n  if (y) /\\(/.test(y);\n  return 1;\n}\nexport function extra04b(): number { return 4; }\n", expected: ["atk04b", "extra04b"] },
  { title: "r5 regex after if-condition holding a backtick", path: "server/src/x/p.atk04c.ts", src: "export function atk04c(y: string): number {\n  if (y) /`/.test(y);\n  return 1;\n}\nexport function extra04c(): number { return 4; }\n", expected: ["atk04c", "extra04c"] },
  { title: "r5 regex after while-condition holding {", path: "server/src/x/p.atk04d.ts", src: "export function atk04d(y: string): number {\n  while (y) /[{]/.test(y);\n  return 1;\n}\nexport function extra04d(): number { return 4; }\n", expected: ["atk04d", "extra04d"] },
  { title: "r5 export default regex", path: "server/src/x/p.atk13.ts", src: "export default /\\(/;\nexport function f13a() { return 1; }\nexport function f13b() { return 2; }\n", expected: ["f13a", "f13b"] },
  { title: "r5 postfix ++ then division then template", path: "server/src/x/p.atk10.ts", src: "export function atk10(xs: string[]) { let i = 0; i++ / 2; return xs.join(`a/b`); }\nexport function b10() { return 1; }\nexport function c10() { return 2; }\n", expected: ["atk10", "b10", "c10"] },
  { title: "negative: class, object const, re-export", path: "server/src/x/p.neg.ts", src: "export class Thing { run() { return 1; } }\nexport const config = { a: 1, run: () => 2 };\nexport { helper } from \"./other\";\n", expected: [] },
  { title: "r6 keyword-named property then division: .default", path: "server/src/x/policy.toSeconds.ts", src: "export function toSeconds(timeouts: { default: number }): number {\n  return Math.round(timeouts.default / 1000);\n}\nexport function toMinutes(timeouts: { default: number }): number {\n  return Math.round(timeouts.default / 60000);\n}\n", expected: ["toMinutes", "toSeconds"] },
  { title: "r6 keyword-named property then division: .new", path: "server/src/x/policy.churn.ts", src: "export function churn(diff: { new: number; total: number }): number {\n  return Math.round((diff.new / diff.total) * 100);\n}\nexport function other(): number { return 1; }\n", expected: ["churn", "other"] },
  { title: "r6 member named like a condition keyword", path: "server/src/x/p.memberIf.ts", src: "export function memberIf(x: { if(a: number): number }, b: number) { return x.if(1) / b; }\nexport function next() { return 2; }\n", expected: ["memberIf", "next"] },
  { title: "r6 spaced + + before a regex", path: "server/src/x/p.spaced.ts", src: "export function spaced(a: number, s: string) { return a + +/[(]/.test(s); }\nexport function after() { return 1; }\n", expected: ["after", "spaced"] },
  { title: "r6 for await condition then regex", path: "server/src/x/p.forAwait.ts", src: "export async function forAwait(xs: AsyncIterable<string>, y: string) {\n  for await (const k of xs) /\\(/.test(y + k);\n  return 1;\n}\nexport function tail() { return 2; }\n", expected: ["forAwait", "tail"] },
  { title: "r6 one-line postfix division then template", path: "server/src/x/p.postfix.ts", src: "export function postfix(xs: string[]) { let i = 0; return [i++ / 2, xs.join(`a/b`)]; }\nexport function more() { return 1; }\n", expected: ["more", "postfix"] },
  { title: "r7 named default function is checked under its name", path: "server/src/x/policy.admit.ts", src: "export default function wrongName() { return 1; }\n", expected: ["wrongName"] },
  { title: "r7 named default plus its own export-list entry counts once", path: "server/src/x/p.dn.ts", src: "export default function dn() { return 1; }\nexport { dn };\n", expected: ["dn"] },
  { title: "r7 conditional whose branches are both functions", path: "server/src/x/p.pick.ts", src: "declare const cond: boolean;\nexport const pick = cond ? () => 1 : () => 2;\nexport function second() { return 3; }\n", expected: ["pick", "second"] },
];

describe("detector agrees with TypeScript on every verifier attack form", () => {
  for (const c of DETECTOR_CASES) {
    test(c.title, () => {
      expect([...exportedFunctionNames(c.src, c.path)].sort()).toEqual(c.expected);
    });
  }
});
