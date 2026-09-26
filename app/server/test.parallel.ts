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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

const shardCount = Math.max(1, Number(process.argv[2] ?? process.env.TEST_SHARDS ?? 6));
const shards: { files: string[]; load: number }[] = Array.from({ length: shardCount }, () => ({
  files: [],
  load: 0,
}));
// Longest-processing-time-first: heaviest file into the lightest shard.
for (const f of [...files].sort((a, b) => weight(b) - weight(a))) {
  const lightest = shards.reduce((min, s) => (s.load < min.load ? s : min));
  lightest.files.push(f);
  lightest.load += weight(f);
}

const logDir = join(here, ".tmp", "test-parallel");
mkdirSync(logDir, { recursive: true });
const started = performance.now();
console.log(
  `test.parallel: ${files.length} files in ${shardCount} shards (census load ${shards
    .map((s) => s.load.toFixed(0) + "s")
    .join(" / ")})`,
);

type ShardResult = {
  index: number;
  exitCode: number;
  pass: number | null;
  fail: number | null;
  ranFiles: number | null;
  seconds: number;
  failures: string[];
};

const results: ShardResult[] = await Promise.all(
  shards.map(async (shard, index) => {
    const t0 = performance.now();
    const scratch = mkdtempSync(join(tmpdir(), `arra-shard-${index}-`));
    // TEST_TIMEOUT_MS raises bun's 5 s per-test default. Gated-process tests
    // that finish in ~2 s here took ~5-6.5 s on a GitHub runner (measured,
    // run 36253113031), so CI sets it; locally it stays unset.
    const timeout = process.env.TEST_TIMEOUT_MS ? ["--timeout", process.env.TEST_TIMEOUT_MS] : [];
    const proc = Bun.spawn(["bun", "test", ...timeout, ...shard.files], {
      cwd: here,
      env: { ...process.env, TMPDIR: scratch },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    const text = out + err;
    writeFileSync(join(logDir, `shard-${index}.log`), text);
    const num = (re: RegExp) => {
      const m = text.match(re);
      return m ? Number(m[1]) : null;
    };
    const result: ShardResult = {
      index,
      exitCode,
      pass: num(/^\s*(\d+) pass\s*$/m),
      fail: num(/^\s*(\d+) fail\s*$/m),
      ranFiles: num(/^Ran \d+ tests? across (\d+) files?\./m),
      seconds: (performance.now() - t0) / 1000,
      failures: text.split("\n").filter((l) => /^\s*(✗|\(fail\))/.test(l)),
    };
    console.log(
      `  shard ${index}: ${result.pass ?? "?"} pass, ${result.fail ?? "?"} fail, ${result.ranFiles ?? "?"}/${shard.files.length} files, rc=${exitCode}, ${result.seconds.toFixed(1)}s`,
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
// A shard can fail with no named test (a hook timeout, a crash before the
// summary). Print its log tail so the cause is visible in CI output, not only
// in a .tmp file the runner throws away.
for (const r of results) {
  if (r.exitCode !== 0 && r.failures.length === 0) {
    const tail = readFileSync(join(logDir, `shard-${r.index}.log`), "utf8").split("\n").slice(-40).join("\n");
    console.log(`  [shard ${r.index}] exited ${r.exitCode} with no named failure; last 40 log lines:\n${tail}`);
  }
}
console.log(
  `\n ${sum("pass")} pass\n ${sum("fail")} fail\nRan ${sum("pass") + sum("fail")} tests across ${sum("ranFiles")}/${files.length} files in ${shardCount} shards. [${((performance.now() - started) / 1000).toFixed(2)}s]`,
);
if (problems.length > 0) {
  console.log(`PARALLEL SUITE FAILED: ${problems.join("; ")}`);
  process.exit(1);
}
console.log("PARALLEL SUITE PASSED");
