// Sharded full-suite runner: every test file, split across N concurrent
// `bun test` processes, balanced by the measured per-file time in
// test.census.tsv.
//
// Why: `bun run test` runs all files in ONE process. Measured 2026-09-26 on
// f919369: 1123 tests / 68 files in 496.65s wall at 114% CPU. Most of that
// is gate-serialized recovery tests waiting on their own temp datasets, so
// separate processes with separate TMPDIRs can overlap them.
//
// Guarantees, each checked rather than assumed:
//   - every file in test.order.txt plus every ../cli*.test.ts file runs in
//     exactly one shard
//   - the per-shard "Ran N tests across M files" lines sum to the file count;
//     a shard that crashes before printing its summary fails the run
//   - exit code is nonzero on any failing test, any nonzero shard exit,
//     or any unparseable shard output
//
// Usage: bun test.parallel.ts [shards]   (default: TEST_SHARDS or 6)
// Logs:  .tmp/test-parallel/shard-<i>.log
//
// R13 (docs/overnight/DECISIONS.md), CI matrix: TEST_GROUPS=G and
// TEST_GROUP=g (0-based) first split the file list into G groups by the same
// LPT rule, and this process runs only group g, in TEST_SHARDS shards. Every
// job computes the identical partition from the same inputs, and checks that
// the groups are disjoint and cover every file, so G jobs together still run
// each file exactly once. Unset, it is one group: the whole suite.
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { availableParallelism, tmpdir } from "node:os";

const here = import.meta.dir;

const order = Bun.spawnSync(["bun", "test.order.ts"], { cwd: here, stdout: "pipe", stderr: "pipe" });
if (order.exitCode !== 0) {
  process.stderr.write(order.stderr);
  throw new Error("test.parallel.ts: test.order.ts failed");
}
// `cli.test.ts` itself lives one level up (outside test/, hardcoded here
// rather than by test.order.ts's test/-only scan); style splits add
// cli-*.test.ts siblings, so this globs the parent directory instead of
// naming one file, matching the per-kernel package.json scripts' `-*.test.ts`
// convention.
const cliTestFiles = readdirSync(join(here, ".."))
  .filter((f) => /^cli.*\.test\.ts$/.test(f))
  .sort();
const files = readFileSync(join(here, "test.order.txt"), "utf8")
  .split("\n")
  .filter(Boolean)
  .concat(cliTestFiles.map((f) => `../${f}`));

const census = new Map<string, number>();
for (const line of readFileSync(join(here, "test.census.tsv"), "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [path, seconds] = line.split("\t");
  if (path && seconds) census.set(path, Number(seconds));
}
// Unmeasured files are assumed slow so they cannot pile into one shard unseen.
const weight = (f: string) => census.get(f) ?? 60;

/** Longest-processing-time-first: heaviest file into the lightest bin. */
function lpt(list: string[], bins: number): { files: string[]; load: number }[] {
  const out = Array.from({ length: bins }, () => ({ files: [] as string[], load: 0 }));
  for (const f of [...list].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = out.reduce((min, s) => (s.load < min.load ? s : min));
    lightest.files.push(f);
    lightest.load += weight(f);
  }
  return out;
}

const positiveInt = (name: string, raw: string | undefined, fallback: number, min: number): number => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`test.parallel.ts: ${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  return n;
};
const groupCount = positiveInt("TEST_GROUPS", process.env.TEST_GROUPS, 1, 1);
const groupIndex = positiveInt("TEST_GROUP", process.env.TEST_GROUP, 0, 0);
if (groupIndex >= groupCount) throw new Error(`test.parallel.ts: TEST_GROUP=${groupIndex} is outside TEST_GROUPS=${groupCount}`);
const groups = lpt(files, groupCount);
const grouped = groups.flatMap((g) => g.files);
if (grouped.length !== files.length || new Set(grouped).size !== files.length || files.some((f) => !grouped.includes(f))) {
  throw new Error("test.parallel.ts: the group partition does not cover every file exactly once");
}
const groupFiles = groups[groupIndex]!.files;

const shardCount = Math.max(1, Number(process.argv[2] ?? process.env.TEST_SHARDS ?? 6));
const shards = lpt(groupFiles, shardCount);

// Files that assign process.env.ARRA_DATA_DIR in-process run in a `bun test`
// process of their own. src/storage.storageOptions.ts reads ARRA_DATA_DIR once,
// at first import, and src/db.ts caches its connection for the process, so two
// such files sharing one process silently use whichever data dir was imported
// first (measured 2026-09-28: remember-taxonomy-parity and mcp-correctness each
// pass alone and fail 3-15 tests when LPT puts them in the same shard).
const ownsDataDir = (f: string) =>
  /process\.env\.(ARRA_DATA_DIR|ARRA_OPS_DIR)\s*=/.test(readFileSync(join(here, f), "utf8"));
/** One shard's `bun test` invocations: the shared files together, then each data-dir owner alone. */
const invocations = (shardFiles: readonly string[]): string[][] => {
  const own = shardFiles.filter(ownsDataDir);
  const shared = shardFiles.filter((f) => !own.includes(f));
  return [...(shared.length ? [shared] : []), ...own.map((f) => [f])];
};

const logDir = join(here, ".tmp", "test-parallel");
mkdirSync(logDir, { recursive: true });
const started = performance.now();
const cores = availableParallelism();
console.log(
  `test.parallel: ${groupCount > 1 ? `group ${groupIndex + 1}/${groupCount}, ${groupFiles.length} of ${files.length}` : files.length} files in ${shardCount} shards on ${cores} cores (census load ${shards
    .map((s) => s.load.toFixed(0) + "s")
    .join(" / ")}); TEST_TIMEOUT_MS=${process.env.TEST_TIMEOUT_MS ?? "unset"} TEST_TIME_SCALE=${process.env.TEST_TIME_SCALE ?? "unset"}`,
);

type ShardResult = {
  index: number;
  exitCode: number;
  pass: number | null;
  fail: number | null;
  ranFiles: number | null;
  seconds: number;
  /** User+system CPU of the shard AND every descendant it reaped (python, gated bun children). */
  cpuSeconds: number | null;
  failures: string[];
  /** Failures bun cannot name -- a hook that threw, an error between tests -- with the file they came from. */
  unnamed: string[];
};

/**
 * Attribute every "(fail) (unnamed)" and "# Unhandled error between tests" to
 * the test file it came from, with the error lines bun printed just before.
 * bun marks files as `::group::<file>:` under GitHub Actions and `<file>:`
 * otherwise. Without this, CI said only "(unnamed) [13712.60ms]" three times
 * and the cause (E2BIG in three different files) had to be dug out of logs.
 */
function unnamedFailures(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  let file = "(before any file)";
  let fileStart = 0;
  for (const [i, line] of lines.entries()) {
    // bun repeats every failure in a closing "N tests failed:" summary;
    // those repeats belong to no file and must not be attributed again.
    if (/^\d+ tests? failed:$/.test(line)) break;
    const header = line.match(/^(?:::group::)?(\S+\.test\.ts):$/);
    if (header) {
      file = header[1]!;
      fileStart = i + 1;
    }
    if (line === "::endgroup::") file = "(between files)";
    if (/^\(fail\) \(unnamed\)/.test(line) || /^# Unhandled error between tests/.test(line)) {
      // A thrown hook prints its error BEFORE the fail line, a timed-out hook
      // AFTER it, an error between tests after its banner.
      const window = /^#/.test(line) ? lines.slice(i + 2, i + 14) : lines.slice(Math.max(fileStart, i - 14), i + 3);
      const cause = window.filter((l) => /error|Error|E2BIG|timed out|Timeout/.test(l)).slice(0, 3);
      out.push(`${file}: ${line.trim()}${cause.length ? ` <- ${cause.map((l) => l.trim().slice(0, 200)).join(" | ")}` : ""}`);
    }
  }
  return out;
}

const results: ShardResult[] = await Promise.all(
  shards.map(async (shard, index) => {
    const t0 = performance.now();
    const scratch = mkdtempSync(join(tmpdir(), `arra-shard-${index}-`));
    // TEST_TIMEOUT_MS raises bun's 5 s per-test default. Gated-process tests
    // that finish in ~2 s here took ~5-6.5 s on a GitHub runner (measured,
    // run 36253113031), so CI sets it; locally it stays unset.
    const timeout = process.env.TEST_TIMEOUT_MS ? ["--timeout", process.env.TEST_TIMEOUT_MS] : [];
    // Streamed to the log AS IT ARRIVES (R13): a job cancelled at its
    // timeout-minutes still uploads what every shard printed so far, which
    // names the file that was running. The parse below reads out + err.
    const logPath = join(logDir, `shard-${index}.log`);
    writeFileSync(logPath, "");
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const decoder = new TextDecoder();
      let all = "";
      for await (const chunk of stream) {
        const piece = decoder.decode(chunk, { stream: true });
        all += piece;
        appendFileSync(logPath, piece);
      }
      return all + decoder.decode();
    };
    // Each invocation prints its own summary; a missing one makes the shard's
    // total null, which the checks below report as an incomplete shard.
    let exitCode = 0;
    let cpuMicros: number | null = 0;
    const texts: string[] = [];
    const totals: { pass: number | null; fail: number | null; ranFiles: number | null } = { pass: 0, fail: 0, ranFiles: 0 };
    for (const files of invocations(shard.files)) {
      const proc = Bun.spawn(["bun", "test", ...timeout, ...files], {
        cwd: here,
        env: { ...process.env, TMPDIR: scratch },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const code = await proc.exited;
      if (exitCode === 0) exitCode = code;
      const text = out + err;
      texts.push(text);
      const cpu = proc.resourceUsage()?.cpuTime.total;
      cpuMicros = cpu === undefined || cpuMicros === null ? null : cpuMicros + Number(cpu);
      const num = (re: RegExp) => {
        const m = text.match(re);
        return m ? Number(m[1]) : null;
      };
      const add = (k: "pass" | "fail" | "ranFiles", v: number | null) => {
        totals[k] = v === null || totals[k] === null ? null : totals[k]! + v;
      };
      add("pass", num(/^\s*(\d+) pass\s*$/m));
      add("fail", num(/^\s*(\d+) fail\s*$/m));
      add("ranFiles", num(/^Ran \d+ tests? across (\d+) files?\./m));
    }
    const text = texts.join("\n");
    const result: ShardResult = {
      index,
      exitCode,
      ...totals,
      seconds: (performance.now() - t0) / 1000,
      cpuSeconds: cpuMicros === null ? null : cpuMicros / 1e6,
      failures: text.split("\n").filter((l) => /^\s*(✗|\(fail\))/.test(l)),
      unnamed: texts.flatMap(unnamedFailures),
    };
    console.log(
      `  shard ${index}: ${result.pass ?? "?"} pass, ${result.fail ?? "?"} fail, ${result.ranFiles ?? "?"}/${shard.files.length} files, rc=${exitCode}, ${result.seconds.toFixed(1)}s wall, ${result.cpuSeconds?.toFixed(1) ?? "?"}s cpu`,
    );
    return result;
  }),
);

const sum = (k: "pass" | "fail" | "ranFiles") => results.reduce((a, r) => a + (r[k] ?? 0), 0);
const problems: string[] = [];
for (const r of results) {
  if (r.exitCode !== 0) problems.push(`shard ${r.index} exited ${r.exitCode}`);
  if (r.pass === null || r.fail === null || r.ranFiles === null)
    problems.push(`shard ${r.index} printed no complete summary (see .tmp/test-parallel/shard-${r.index}.log)`);
  else if (r.ranFiles !== shards[r.index].files.length)
    problems.push(`shard ${r.index} ran ${r.ranFiles} of ${shards[r.index].files.length} files`);
}
if (sum("fail") > 0) problems.push(`${sum("fail")} failing test(s)`);

for (const r of results) for (const f of r.failures) console.log(`  [shard ${r.index}] ${f.trim()}`);
for (const r of results) for (const u of r.unnamed) console.log(`  [shard ${r.index}] UNNAMED in ${u}`);
// A shard can fail with no named test (a hook timeout, a crash before the
// summary). Print its log tail so the cause is visible in CI output, not only
// in a .tmp file the runner throws away.
for (const r of results) {
  if (r.exitCode !== 0 && r.failures.length === 0) {
    const tail = readFileSync(join(logDir, `shard-${r.index}.log`), "utf8").split("\n").slice(-40).join("\n");
    console.log(`  [shard ${r.index}] exited ${r.exitCode} with no named failure; last 40 log lines:\n${tail}`);
  }
}
const wall = (performance.now() - started) / 1000;
const cpuTotal = results.reduce((a, r) => a + (r.cpuSeconds ?? 0), 0);
console.log(
  `\n ${sum("pass")} pass\n ${sum("fail")} fail\nRan ${sum("pass") + sum("fail")} tests across ${sum("ranFiles")}/${groupFiles.length} files in ${shardCount} shards. [${wall.toFixed(2)}s]`,
);
// Is the runner CPU-bound? cpu / (wall x cores) near 1 means more shards on
// the same machine cannot help; only more machines (TEST_GROUPS) can.
console.log(`CPU ${cpuTotal.toFixed(1)}s over ${wall.toFixed(1)}s wall on ${cores} cores: utilisation ${((cpuTotal / (wall * cores)) * 100).toFixed(0)}%`);
if (problems.length > 0) {
  console.log(`PARALLEL SUITE FAILED: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("PARALLEL SUITE PASSED");
