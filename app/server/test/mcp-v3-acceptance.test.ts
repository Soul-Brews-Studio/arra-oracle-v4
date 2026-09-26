/**
 * Slice VA -- the v3-compat acceptance harness (#31 legacy adapters).
 *
 * docs/overnight/V3-PARITY.md §8: "One ordered script of real-shaped v3
 * calls... runs against v4 over POST /mcp/:bank with a bearer from a 0600
 * policy file on a fresh mktemp dataset." DECISIONS.md R18 D10:
 * `ARRA_MCP_V3_COMPAT` stays off until this file is green.
 *
 * Rev 2, after an independent review refuted rev 1:
 *  - The app now runs INSIDE the writer gate, in
 *    `fixtures/v3-compat-v1/core/session-child.ts` launched by `runGated`
 *    (`exec_with_gate`, fd 42), exactly like the other live transport tests.
 *    Rev 1 built it in the plain test process, where every content:write
 *    failed `writer_unavailable`, so no write step could ever pass.
 *  - Every step is PASS, FAIL or GAP (`helpers/v3-compat-verdict.ts`). GAP --
 *    a tool the step depends on is not advertised -- is registered as
 *    `test.todo`, so it is never counted as a pass, and the summary line
 *    prints all three counts. Steps that only assert an absence (the
 *    read-only list, the read-only write refusal, the not-carried tool) are
 *    gated on the tools that make that absence meaningful.
 *  - Shapes follow V3-PARITY's v4 outputs (§2.5 null + compat_warnings,
 *    `embedding:"enqueued"`, `source:"node"`, string thread ids), and the
 *    dropped §8 steps are back: distill then search, the thread list, the
 *    `answered` refusal and the repeated supersede.
 *
 * The session script (`fixtures/v3-compat-v1/sessions/v3-session-01.json`)
 * and the shapes (`fixtures/v3-compat-v1/shapes/*.json`) are real: argument
 * keys come from recorded `mcp__arra-oracle__*` / `mcp__oracle-v2__*` calls
 * (each step's `provenance`), output shapes cite `arra-oracle-v3` at
 * `61e5f8b6` file:line.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, PYTHON, revisionEnvelope, runGated, type Fixture, type RunResult } from "./helpers/publication-fixture";
import { FIXTURES_DIR, loadSession } from "./helpers/v3-compat-shapes";
import { judgeStep, type SessionRun, type Verdict } from "./helpers/v3-compat-verdict";
import { scaledMs } from "./helpers/timing.scaledMs";

const session = loadSession();
const SEED_CHILD = join(FIXTURES_DIR, "core", "gated-session.ts");
const SESSION_CHILD = join(FIXTURES_DIR, "core", "session-child.ts");
const SESSION_DEADLINE_MS = scaledMs(240_000);

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const lastLine = (result: RunResult) => result.stdout.trim().split("\n").filter(Boolean).at(-1);

const MISSING: string[] = [];
if (!existsSync(PYTHON)) MISSING.push(`python interpreter at ${PYTHON} (set ARRA_CONTRACT_PYTHON)`);
for (const child of [SEED_CHILD, SESSION_CHILD]) if (!existsSync(child)) MISSING.push(child);

// ─── setup at module load: the verdicts decide how each test is registered ──
//
// A GAP must be known BEFORE `test` / `test.todo` is chosen, so the dataset,
// the bank-b seed and the whole gated session run here, not in beforeAll.

let fixture: Fixture | null = null;
let workDir: string | null = null;
let setupError: string | null = null;
let seeded: { ok?: boolean; value?: { outcome?: string; node_id?: string } } | null = null;
let run: SessionRun | null = null;

if (MISSING.length === 0) {
  try {
    fixture = await createFixture(["bank-a", "bank-b"]);
    workDir = await mkdtemp(join(tmpdir(), "arra-v3-compat-"));
    await mkdir(join(workDir, "legacy"));

    // A real node in bank-b, planted through the real gate, for the
    // cross-tenant steps (the session must never see it from bank-a).
    const seedNode = pad("v3vaseed1");
    const content = revisionEnvelope("bank-b", fixture.workspaces["bank-b"]!, seedNode, {
      title: "bank-b baseline (never visible from bank-a)",
      body: "planted by test/fixtures/v3-compat-v1/core/gated-session.ts for slice VA's isolation steps",
    });
    const seed = await runGated(fixture.datasetRoot, SEED_CHILD, [
      fixture.datasetRoot,
      JSON.stringify({ ops: [{ facade: "publication", method: "publishRevision", request: { operation_id: "v3-compat-va:seed:bank-b:1", content } }] }),
    ]);
    if (seed.code !== 0) throw new Error(`gated-session.ts exited ${seed.code}: ${seed.stderr.slice(0, 700)}`);
    seeded = JSON.parse(lastLine(seed) ?? "{}").op0 ?? null;

    const result = await runGated(fixture.datasetRoot, SESSION_CHILD, [fixture.datasetRoot, workDir], {
      deadlineMs: SESSION_DEADLINE_MS,
      env: {
        ARRA_DATA_DIR: join(workDir, "legacy"),
        ARRA_KNOWLEDGE_DATASET_ROOT: fixture.datasetRoot,
        // R18 D10: on for the harness; the frame test proves off is the default.
        ARRA_MCP_V3_COMPAT: "1",
      },
    });
    const line = lastLine(result);
    if (result.code !== 0 || line === undefined) {
      throw new Error(`session-child.ts exited ${result.code}: ${result.stderr.slice(0, 1500)}`);
    }
    run = JSON.parse(line) as SessionRun;
  } catch (error) {
    setupError = error instanceof Error ? error.message : String(error);
  }
}

afterAll(async () => {
  await fixture?.cleanup();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("preflight: the Python gate and both children are present", () => {
  expect(MISSING).toEqual([]);
});

test("setup: fresh dataset, bank-b seed and the gated session all ran", () => {
  expect(setupError).toBeNull();
  expect(seeded?.ok).toBe(true);
  expect(seeded?.value?.outcome).toBe("accepted");
  expect(seeded?.value?.node_id).toBe(pad("v3vaseed1"));
});

// ─── the session, one test per step ──────────────────────────────────────

// Judged here, at load, so the summary below and the test registration agree.
const verdicts: { step: number; verdict: Verdict }[] =
  run === null ? [] : session.steps.map((step) => ({ step: step.step, verdict: judgeStep(step, run!, session) }));

describe("v3 client session over the real wire, inside the writer gate (v3-session-01.json)", () => {
  for (const step of session.steps) {
    const title = `step ${step.step} [${step.slice}] as ${step.as} -- ${step.tool ?? step.method}`;
    const verdict = verdicts.find((v) => v.step === step.step)?.verdict;
    if (verdict === undefined) {
      test(title, () => {
        throw new Error(`no session run: ${setupError ?? MISSING.join(", ")}`);
      });
    } else if (verdict.verdict === "GAP") {
      // Bun's types want a body; it only runs under --todo, where a GAP must not pass.
      test.todo(`${title} [GAP: ${verdict.reason}]`, () => {
        throw new Error(`GAP: ${verdict.reason}`);
      });
    } else {
      test(title, () => {
        expect(verdict.errors, step.assert.notes).toEqual([]);
      });
    }
  }
});

const count = (kind: Verdict["verdict"]) => verdicts.filter((v) => v.verdict.verdict === kind).length;
const summary = `v3-compat acceptance: PASS ${count("PASS")} / FAIL ${count("FAIL")} / GAP ${count("GAP")} of ${session.steps.length} steps`;
console.log(summary);
for (const { step, verdict } of verdicts) {
  if (verdict.verdict !== "PASS") console.log(`  step ${step}: ${verdict.verdict} -- ${verdict.reason}`);
}
afterAll(() => console.log(summary));
