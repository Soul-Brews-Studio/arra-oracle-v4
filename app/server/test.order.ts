// Fast-first test ordering, driven by MEASURED per-file time.
//
// Sorts test/*.test.ts (recursively) by the wall-clock time recorded in
// test.census.tsv (see that file — generate/regenerate with
// ./test-census.sh). A regression in a fast file then fails in seconds
// instead of waiting behind however many minutes of gate-serialized
// recovery tests happen to sort after it.
//
// Also writes test.fast.txt: every file below SLOW_CENSUS_CUTOFF_SECONDS,
// for the `test:fast` script. The cutoff was chosen from the measured
// 2026-09-21 census: sorted descending, the biggest gap in the top 20 falls
// between 31.76s (test/context-service.test.ts) and 40.30s
// (test/trace-precision.test.ts) — a clean ~8.5s jump versus neighbouring
// gaps of 1-3s. 35s sits in that gap. Regenerate the census and re-eyeball
// this constant if the file set changes enough to move the gap.
//
// A file with NO entry in test.census.tsv (new since the last census, or
// the census was never run) is NOT silently folded into "fast" — that
// would defeat the point of a measured order. It falls back to the old
// name-based isSlow() heuristic for ordering (see test.order.ts history
// before 2026-09-21 for why that heuristic existed and why it turned out
// close to noise on measured data), biased slow, and it is EXCLUDED from
// test.fast.txt until it has a real measurement. Every such file is named
// in a loud stderr warning — see `missing` below — because a script that
// can't report its own incompleteness will drift silently, the same
// failure mode the recursive-scan self-check below exists to catch.
//
// Regenerate this file's output with `bun run test:order`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const testDir = join(import.meta.dir, "test");
const files = (readdirSync(testDir, { recursive: true }) as string[]).filter((f) =>
  f.endsWith(".test.ts"),
);

// Independent cross-check: walk the tree by hand, without the `{ recursive:
// true }` option, and compare counts. Two different scan implementations
// agreeing is real evidence; the same call checked against itself is not.
// This is what would have caught the original non-recursive readdirSync bug
// — it fails loudly instead of silently shipping a partial `test.order.txt`.
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name)));
    else if (entry.name.endsWith(".test.ts")) out.push(join(dir, entry.name));
  }
  return out;
}
const walked = walk(testDir).length;
if (files.length !== walked) {
  throw new Error(
    `test.order.ts: readdirSync({recursive:true}) found ${files.length} .test.ts files but an independent manual walk finds ${walked} — scan methods diverged, do not trust test.order.txt`,
  );
}

const SLOW_CENSUS_CUTOFF_SECONDS = 35;
const isSlow = (name: string) => /recovery|ownership/.test(name);

const CENSUS_PATH = join(import.meta.dir, "test.census.tsv");
const census = new Map<string, number>();
if (existsSync(CENSUS_PATH)) {
  for (const line of readFileSync(CENSUS_PATH, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [path, seconds] = line.split("\t");
    if (path && seconds) census.set(path, Number(seconds));
  }
} else {
  console.warn(
    "test.order.ts: test.census.tsv not found — every file falls back to the name-based isSlow() heuristic. Run ./test-census.sh to measure.",
  );
}

const missing: string[] = [];
function priority(relPath: string): number {
  const key = `test/${relPath}`;
  const measured = census.get(key);
  if (measured !== undefined) return measured;
  missing.push(key);
  // No measurement — bias slow so an unmeasured file can never sort as if
  // it were cheap. 1e6/1e5 are simply "bigger than any real file time".
  return isSlow(relPath) ? 1e6 : 1e5;
}

files.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));

if (missing.length > 0) {
  console.warn(
    `test.order.ts: ${missing.length} file(s) have no entry in test.census.tsv — ordered by name heuristic (slow-biased) instead of measured time, and excluded from test.fast.txt until measured. Regenerate with ./test-census.sh:\n${missing.map((f) => `  ${f}`).join("\n")}`,
  );
}

const lines = files.map((f) => `test/${f}`);
writeFileSync(join(import.meta.dir, "test.order.txt"), lines.join("\n") + "\n");

const fastFiles = files.filter((f) => {
  const t = census.get(`test/${f}`);
  return t !== undefined && t < SLOW_CENSUS_CUTOFF_SECONDS;
});
writeFileSync(
  join(import.meta.dir, "test.fast.txt"),
  fastFiles.map((f) => `test/${f}`).join("\n") + "\n",
);

const slowTierCount = files.length - fastFiles.length - missing.length;
console.log(
  `${lines.length} files ordered by measured time: ${fastFiles.length} in test:fast (<${SLOW_CENSUS_CUTOFF_SECONDS}s), ${slowTierCount} slow tier, ${missing.length} unmeasured`,
);
