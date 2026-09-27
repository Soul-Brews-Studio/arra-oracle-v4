// The driver-lifetime rules of app/just/ui-e2e.sh, checked without a
// browser: `harness` gets a stand-in page, a fresh mktemp dir holds the
// transcript and the lease. ego-browser itself is not in CI; these rules are
// the part of the harness that decides what a verdict is, so they are.
//
//   - every line lands in cfg.transcript as it is said (stdout from
//     `ego-browser nodejs` only arrives at exit, so it cannot be the log)
//   - past cfg.deadline, a step is a STEP_FAIL, never silently skipped
//   - with the lease gone, the driver aborts and writes nothing more, so a
//     straggler cannot add a verdict after the shell has judged the run
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HARNESS = process.env.UI_E2E_HARNESS ?? join(import.meta.dir, "ui-e2e", "harness.mjs");
const roots: string[] = [];

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "arra-ui-e2e-harness-"));
  roots.push(root);
  const cfg = { outDir: root, transcript: join(root, "transcript.txt"), lease: join(root, "lease"), deadline: Date.now() + 60_000 };
  writeFileSync(cfg.transcript, "");
  writeFileSync(cfg.lease, "");
  const mod = await import(HARNESS);
  const make = mod.harness ?? mod.makeHarness;
  const page = { evaluate: async (fn: (a?: unknown) => unknown, arg?: unknown) => fn(arg) };
  const h = make({ page, cfg, outDir: root });
  const lines = () => (existsSync(cfg.transcript) ? readFileSync(cfg.transcript, "utf8").split("\n").filter(Boolean) : []);
  return { cfg, h, lines };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("ui-e2e harness: driver lifetime", () => {
  test("a verdict is in the transcript file the moment it is decided", async () => {
    const { h, lines } = await setup();
    await h.step("alpha", async () => "fine");
    expect(lines()).toEqual(["STEP_OK alpha fine"]);
  });

  test("past the deadline, the next step is a STEP_FAIL naming the deadline", async () => {
    const { cfg, h, lines } = await setup();
    cfg.deadline = Date.now() - 1;
    let ran = false;
    await h.step("late", async () => { ran = true; });
    expect(ran).toBe(false);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^STEP_FAIL late: driver deadline passed/);
    expect(h.failures).toEqual(["late"]);
  });

  test("a deadline passing inside a DOM wait fails that step at the deadline", async () => {
    const { cfg, h, lines } = await setup();
    cfg.deadline = Date.now() + 300;
    await h.step("slow", async () => h.waitDom("never", () => false, undefined, 10_000));
    expect(lines()[0]).toMatch(/^STEP_FAIL slow: driver deadline passed/);
  });

  test("with the lease gone, a step aborts and nothing more is written", async () => {
    const { cfg, h, lines } = await setup();
    await h.step("before", async () => "ok");
    rmSync(cfg.lease);
    let ran = false;
    const outcome = await h.step("after", async () => { ran = true; }).then(() => "resolved", (e: { abort?: boolean }) => (e.abort ? "aborted" : "other error"));
    h.say("STEP_OK forged");
    expect(outcome).toBe("aborted");
    expect(ran).toBe(false);
    expect(lines()).toEqual(["STEP_OK before ok"]);
  });

  test("the lease going away mid-wait aborts the wait instead of passing or failing it", async () => {
    const { cfg, h, lines } = await setup();
    setTimeout(() => rmSync(cfg.lease), 200);
    const outcome = await h.step("waiting", async () => h.waitDom("never", () => false, undefined, 10_000))
      .then(() => "resolved", (e: { abort?: boolean }) => (e.abort ? "aborted" : "other error"));
    expect(outcome).toBe("aborted");
    expect(lines()).toEqual([]);
  });
});
