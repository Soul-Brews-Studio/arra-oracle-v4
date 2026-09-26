/**
 * R13 (CI must actually pass, docs/overnight/DECISIONS.md): one knob scales
 * every wall-clock window and explicit timeout in the suite.
 *
 * bun's `--timeout` (what `TEST_TIMEOUT_MS` feeds in `test.parallel.ts`) only
 * sets the DEFAULT; an explicit `test(name, fn, ms)` or hook timeout
 * overrides it, so a slow runner could never raise those. `testTimeout` and
 * `scaledMs` read `TEST_TIME_SCALE` and `TEST_TIMEOUT_MS` so it can.
 *
 * Each case runs in its own process, so the environment under test is exactly
 * the one given and nothing leaks into the rest of this file.
 */

import { describe, expect, test } from "bun:test";

const SCALED = new URL("./helpers/timing.scaledMs.ts", import.meta.url).pathname;
const TIMEOUT = new URL("./helpers/timing.testTimeout.ts", import.meta.url).pathname;

/** Evaluate `expression` with the two helpers imported, under exactly `env`. */
function evaluate(expression: string, env: Record<string, string>): { ok: boolean; out: string } {
  const script = `import { scaledMs } from ${JSON.stringify(SCALED)};
import { testTimeout } from ${JSON.stringify(TIMEOUT)};
try { console.log(JSON.stringify(${expression})); } catch (error) { console.log("THROWN " + error.message); }`;
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "TEST_TIME_SCALE" && key !== "TEST_TIMEOUT_MS") base[key] = value;
  }
  const run = Bun.spawnSync([process.execPath, "-e", script], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString().trim();
  return { ok: run.exitCode === 0 && !out.startsWith("THROWN"), out: out || run.stderr.toString() };
}

describe("timing helpers: identity on the dev box, scaled on a slow runner", () => {
  test("with neither variable set, every value is returned unchanged", () => {
    expect(evaluate("[scaledMs(300), testTimeout(10_000), testTimeout(300_000)]", {}).out).toBe("[300,10000,300000]");
  });

  test("TEST_TIME_SCALE multiplies windows and timeouts alike, rounding up", () => {
    const run = evaluate("[scaledMs(300), scaledMs(0.5), testTimeout(10_000)]", { TEST_TIME_SCALE: "5" });
    expect(run.out).toBe("[1500,3,50000]");
  });

  test("TEST_TIMEOUT_MS is a floor for explicit timeouts, never a ceiling, and never touches windows", () => {
    const run = evaluate("[testTimeout(10_000), testTimeout(300_000), scaledMs(300)]", { TEST_TIMEOUT_MS: "60000" });
    expect(run.out).toBe("[60000,300000,300]");
  });

  test("both together: the larger of the scaled budget and the floor", () => {
    const run = evaluate("[testTimeout(10_000), testTimeout(25_000)]", { TEST_TIME_SCALE: "5", TEST_TIMEOUT_MS: "60000" });
    expect(run.out).toBe("[60000,125000]");
  });

  test("an empty value is unset, like bun's own flags", () => {
    expect(evaluate("[scaledMs(300), testTimeout(1_000)]", { TEST_TIME_SCALE: "", TEST_TIMEOUT_MS: "" }).out).toBe("[300,1000]");
  });

  test("a scale that would SHRINK windows, or a value that is not a number, is refused loudly", () => {
    for (const bad of ["0.5", "0", "-2", "abc", "Infinity"]) {
      const run = evaluate("scaledMs(300)", { TEST_TIME_SCALE: bad });
      expect(run.ok, `TEST_TIME_SCALE=${bad} -> ${run.out}`).toBe(false);
      expect(run.out).toContain("TEST_TIME_SCALE");
    }
    for (const bad of ["0", "-1", "soon"]) {
      const run = evaluate("testTimeout(300)", { TEST_TIMEOUT_MS: bad });
      expect(run.ok, `TEST_TIMEOUT_MS=${bad} -> ${run.out}`).toBe(false);
      expect(run.out).toContain("TEST_TIMEOUT_MS");
    }
  });
});
