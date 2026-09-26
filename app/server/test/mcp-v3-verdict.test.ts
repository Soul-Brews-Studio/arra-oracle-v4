// The acceptance verdict for the alias step (docs/overnight/V3-PARITY.md §8
// step 22, §2.4 D6; DECISIONS.md R18), no dataset.
//
// Written red first, after an independent review showed step 30 flaky: it
// compared `arra_search` with step 13's `oracle_search`, but step 21 writes a
// node in between, so the two ran against different datasets and the kernel's
// best-chunk snippet could differ (3 FAIL in 6 runs). "Same result set" is only
// a claim about two calls at the SAME dataset state, so the session child now
// calls the canonical tool with the same arguments right after the alias and
// the verdict compares with that call.

import { describe, expect, test } from "bun:test";
import { loadSession, type SessionScript, type Step } from "./helpers/v3-compat-shapes";
import { judgeStep, type SessionRun, type Wire } from "./helpers/v3-compat-verdict";

const wire = (value: unknown): Wire => ({ status: 200, json: { result: { content: [{ type: "text", text: JSON.stringify(value) }] } } });
const row = (snippet: string) => ({ id: "L1", content: "APFS snapshots keep a rollback point", score: 1, v4: { snippet } });
const earlier: Step = {
  step: 13, ref: "search-earlier", slice: "V5", as: "rw", method: "tools/call", tool: "oracle_search",
  arguments: { query: "APFS" }, provenance: [], assert: { kind: "listed_and_ok", notes: "" },
};
const alias: Step = {
  step: 30, slice: "V0+V5", as: "rw", method: "tools/call", tool: "arra_search", arguments: { query: "APFS" },
  gate: [{ as: "rw", tool: "oracle_search" }], provenance: [],
  assert: { kind: "alias_matches", aliasOf: "oracle_search", neverListed: true, compareToCanonicalCall: true, notes: "" },
};
const session = { version: "t", principals: {}, notCarried: [], carried: [], steps: [earlier, alias] } as unknown as SessionScript;
const listed = { status: 200, names: ["oracle_search"] };
/** Step 13 ran on an older dataset: same entry, another snippet. */
const runWith = (canonical?: unknown): SessionRun => ({
  lists: { rw: listed, ro: listed, other: listed },
  steps: {
    "13": { call: wire({ results: [row("at apfs")] }) },
    "30": { call: wire({ results: [row("at disk")] }), ...(canonical === undefined ? {} : { canonical: wire(canonical) }) },
  },
  captured: {},
});

describe("an alias step is judged against the canonical tool at the same dataset state", () => {
  test("PASS when the alias answers exactly what the canonical call made right after it answers", () => {
    expect(judgeStep(alias, runWith({ results: [row("at disk")] }), session)).toEqual({ verdict: "PASS", reason: "", errors: [] });
  });

  test("FAIL when the canonical call answers differently, when it is missing, and when both are empty", () => {
    expect(judgeStep(alias, runWith({ results: [row("at apfs")] }), session).verdict).toBe("FAIL");
    expect(judgeStep(alias, runWith(), session).verdict).toBe("FAIL");
    const empty: SessionRun = { ...runWith({ results: [] }), steps: { "30": { call: wire({ results: [] }), canonical: wire({ results: [] }) } } };
    expect(judgeStep(alias, empty, session).errors).toContain("alias returned no results (a vacuous match proves nothing)");
  });

  test("the session script's alias step uses the same-state comparison, not an earlier step", () => {
    const step = loadSession().steps.find((s) => s.assert.kind === "alias_matches")!;
    expect(step.tool).toBe("arra_search");
    expect(step.assert.compareToCanonicalCall).toBe(true);
    expect(step.assert.compareToStepRef).toBeUndefined();
  });
});
