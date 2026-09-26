/**
 * PASS / FAIL / GAP for one step of the v3-compat acceptance session
 * (`docs/overnight/V3-PARITY.md` §8), judged in the parent test process from
 * the raw wire observations `fixtures/v3-compat-v1/core/session-child.ts`
 * recorded inside the writer gate.
 *
 * GAP: a tool the step depends on is not advertised to the principal named in
 * the step's gate. §8: "A step whose tool is not yet advertised is GAP, never
 * PASS." A step whose gate holds is judged in full, and any failed assertion
 * makes it FAIL -- a listed tool never gets the benefit of the doubt.
 */

import { loadShape, matchesShape, PRIMARY_KEY, type As, type Gate, type SessionScript, type Step } from "./v3-compat-shapes";

export type Wire = { status: number; json: unknown };
export type StepOutcome = {
  args?: unknown;
  list?: { status: number; names: string[] };
  call?: Wire;
  /** An alias step's canonical tool, called right after it (`compareToCanonicalCall`). */
  canonical?: Wire;
  unknown?: Wire;
  spawnCalls?: number;
};
export type SessionRun = {
  lists: Record<As, { status: number; names: string[] }>;
  steps: Record<string, StepOutcome>;
  captured: Record<string, unknown>;
};
export type Verdict = { verdict: "PASS" | "FAIL" | "GAP"; reason: string; errors: string[] };

const NANOID21 = /^[A-Za-z0-9_-]{21}$/;

const resultOf = (wire: Wire | undefined) => (wire?.json as { result?: Record<string, unknown> } | null)?.result;
const isToolError = (wire: Wire | undefined) => resultOf(wire)?.isError === true;
const valueOf = (wire: Wire | undefined): unknown => {
  const text = (resultOf(wire)?.content as { text?: unknown }[] | undefined)?.[0]?.text;
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The default gate: the step's own tool (or the tool an alias names), to the step's own principal. */
function gatesOf(step: Step): Gate[] {
  if (step.gate !== undefined) return step.gate;
  const tool = step.assert.aliasOf ?? step.tool;
  return tool === undefined ? [] : [{ as: step.as, tool }];
}

export function judgeStep(step: Step, run: SessionRun, session: SessionScript): Verdict {
  const missing = gatesOf(step).filter((g) => !run.lists[g.as]?.names.includes(g.tool));
  if (missing.length > 0) {
    return { verdict: "GAP", reason: missing.map((g) => `${g.tool} not advertised to ${g.as}`).join("; "), errors: [] };
  }
  const errors = checkStep(step, run, session);
  return { verdict: errors.length === 0 ? "PASS" : "FAIL", reason: errors.length === 0 ? "" : errors[0]!, errors };
}

function stepByRef(session: SessionScript, run: SessionRun, ref: string): { step: Step; outcome: StepOutcome } | null {
  const step = session.steps.find((s) => s.ref === ref);
  return step === undefined ? null : { step, outcome: run.steps[String(step.step)] ?? {} };
}

function argAt(session: SessionScript, run: SessionRun, ref: { stepRef: string; path: string }): unknown {
  const found = stepByRef(session, run, ref.stepRef);
  return (found?.outcome.args as Record<string, unknown> | undefined)?.[ref.path];
}

function checkStep(step: Step, run: SessionRun, session: SessionScript): string[] {
  const a = step.assert;
  const out = run.steps[String(step.step)] ?? {};
  const errors: string[] = [];
  const fail = (message: string) => errors.push(message);

  if (a.kind === "tools_list_gate") {
    const list = out.list;
    if (list?.status !== 200) return [`tools/list status ${list?.status}`];
    for (const name of a.expectListed ?? []) if (!list.names.includes(name)) fail(`${name} must be listed`);
    for (const name of a.expectAbsent ?? []) if (list.names.includes(name)) fail(`${name} must never be listed`);
    if (a.expectOnlyCarriedV3) {
      for (const name of list.names) {
        if (/^(oracle_|arra_|muninn_|____)/.test(name) && !session.carried.includes(name)) fail(`${name} is not a carried v3 tool`);
      }
    }
    return errors;
  }

  if (a.kind === "not_listed_403") {
    if (run.lists[step.as]?.names.includes(step.tool!)) fail(`${step.tool} is listed to ${step.as}`);
    if (out.call?.status !== 403 || !same(out.call.json, { error: "forbidden" })) fail(`expected 403 forbidden, got ${out.call?.status} ${show(out.call?.json)}`);
    if (a.compareToUnknownTool && (out.unknown?.status !== out.call?.status || !same(out.unknown?.json, out.call?.json))) {
      fail(`not byte-identical to unknown tool ${a.compareToUnknownTool}: ${show(out.unknown)}`);
    }
    if (a.assertNoSpawn && out.spawnCalls !== 0) fail(`spawned ${out.spawnCalls} process(es)`);
    return errors;
  }

  if (out.call?.status !== 200) return [`HTTP ${out.call?.status} ${show(out.call?.json)}`];
  const value = valueOf(out.call);

  if (a.kind === "isError_code" || a.kind === "isError_generic") {
    if (!isToolError(out.call)) return [`expected isError, got ${show(value)}`];
    if (a.kind === "isError_generic") return errors;
    const compat = (value as { compat?: { code?: unknown; tool?: unknown } } | undefined)?.compat;
    if (compat?.code !== a.errorCode) fail(`compat.code ${show(compat?.code)} != ${a.errorCode} (${show(value)})`);
    if (compat?.tool !== step.tool) fail(`compat.tool ${show(compat?.tool)} != ${step.tool}`);
    const shape = loadShape("compat-error");
    errors.push(...matchesShape(value, shape.shape as Record<string, unknown>, shape));
    return errors;
  }

  if (isToolError(out.call)) return [`isError: ${show(value)}`];

  if (a.kind === "alias_matches") {
    if (a.neverListed && run.lists[step.as]?.names.includes(step.tool!)) fail(`alias ${step.tool} is listed`);
    // Same-state comparison when asked; else a NAMED earlier step (with no
    // ref named, `stepByRef` would find the alias step itself: a vacuous match).
    const against = a.compareToCanonicalCall ? `${a.aliasOf} called right after it` : a.compareToStepRef;
    if (against === undefined) return [...errors, "alias_matches names nothing to compare with"];
    const other = a.compareToCanonicalCall ? out.canonical : stepByRef(session, run, a.compareToStepRef!)?.outcome.call;
    if (other?.status !== 200 || isToolError(other)) fail(`${against}: HTTP ${other?.status} ${show(valueOf(other))}`);
    const prior = valueOf(other) as { results?: unknown[] } | undefined;
    const results = (value as { results?: unknown[] } | undefined)?.results;
    if (!Array.isArray(results) || results.length === 0) fail("alias returned no results (a vacuous match proves nothing)");
    if (!same(results, prior?.results)) fail(`alias results differ from ${against}`);
    return errors;
  }

  // listed_and_ok
  if (a.shape === "guide") {
    if (typeof value !== "string") return [`guide must be plain text, got ${show(value)}`];
    const guide = loadShape("guide") as { v4Requirements: { mustMention: string[] } };
    for (const phrase of guide.v4Requirements.mustMention) {
      if (!value.toLowerCase().includes(phrase.toLowerCase())) fail(`guide must mention "${phrase}"`);
    }
    return errors;
  }
  if (a.shape) {
    const defs = loadShape(a.shape);
    const key = a.shapeKey ?? PRIMARY_KEY[a.shape]!;
    errors.push(...matchesShape(value, defs[key] as Record<string, unknown>, defs).map((e) => `${a.shape}.${key}${e}`));
  }
  const obj = (value ?? {}) as Record<string, unknown>;

  for (const [field, expected] of Object.entries(a.expectFields ?? {})) {
    if (!same(obj[field], expected)) fail(`${field}: expected ${show(expected)}, got ${show(obj[field])}`);
  }
  for (const [field, capture] of Object.entries(a.expectFieldsFromCapture ?? {})) {
    if (!(capture in run.captured)) fail(`${field}: capture ${capture} never produced`);
    else if (!same(obj[field], run.captured[capture])) fail(`${field}: expected ${capture}=${show(run.captured[capture])}, got ${show(obj[field])}`);
  }
  for (const [field, ref] of Object.entries(a.expectFieldsFromStepArgs ?? {})) {
    const expected = argAt(session, run, ref);
    if (expected === undefined || !same(obj[field], expected)) fail(`${field}: expected ${ref.stepRef}.${ref.path}=${show(expected)}, got ${show(obj[field])}`);
  }
  if (a.expectFirstFileFromStepArgs) {
    const ref = a.expectFirstFileFromStepArgs;
    const first = (obj.files as Record<string, unknown>[] | undefined)?.[0];
    const expected = argAt(session, run, ref);
    if (expected === undefined || first?.[ref.field] !== expected) fail(`files[0].${ref.field}: expected ${show(expected)}, got ${show(first?.[ref.field])}`);
  }
  if (a.expectMessagesFromStepArgs) {
    const got = (obj.messages as { content?: unknown }[] | undefined)?.map((m) => m.content);
    const expected = a.expectMessagesFromStepArgs.map((ref) => argAt(session, run, ref));
    if (!same(got, expected)) fail(`messages in seq order: expected ${show(expected)}, got ${show(got)}`);
  }
  if (a.expectNanoid21Field && !NANOID21.test(String(obj[a.expectNanoid21Field]))) fail(`${a.expectNanoid21Field} is not a nanoid21: ${show(obj[a.expectNanoid21Field])}`);
  if (a.expectStringField && typeof obj[a.expectStringField] !== "string") fail(`${a.expectStringField} must be a string`);
  if (a.expectMessageCount !== undefined && (obj.messages as unknown[] | undefined)?.length !== a.expectMessageCount) {
    fail(`expected ${a.expectMessageCount} messages, got ${(obj.messages as unknown[] | undefined)?.length}`);
  }
  if (a.expectMinTotalDocuments !== undefined && !((obj.total_documents as number) >= a.expectMinTotalDocuments)) {
    fail(`total_documents ${show(obj.total_documents)} < ${a.expectMinTotalDocuments}`);
  }
  if (a.expectEmptyResults && !same(obj.results, [])) fail(`expected no results, got ${show(obj.results)}`);
  for (const [field, expected] of Object.entries(a.expectSummary ?? {})) {
    const got = (obj.summary as Record<string, unknown> | undefined)?.[field];
    if (!same(got, expected)) fail(`summary.${field}: expected ${show(expected)}, got ${show(got)}`);
  }
  for (const [field, expected] of Object.entries(a.metadataEquals ?? {})) {
    const got = (obj.metadata as Record<string, unknown> | undefined)?.[field];
    if (!same(got, expected)) fail(`metadata.${field}: expected ${show(expected)}, got ${show(got)}`);
  }
  const idKey = a.idKey ?? "id";
  const rowsKey = a.rowsKey ?? ["documents", "traces", "results", "threads", "files"].find((k) => Array.isArray(obj[k]));
  const ids = new Set(((rowsKey ? obj[rowsKey] : []) as Record<string, unknown>[] | undefined ?? []).map((r) => r?.[idKey]));
  for (const name of a.includesCaptured ?? []) {
    if (!(name in run.captured) || !ids.has(run.captured[name])) fail(`${rowsKey ?? "rows"} must include ${name}=${show(run.captured[name])}`);
  }
  for (const name of a.excludesCaptured ?? []) {
    if (!(name in run.captured)) fail(`capture ${name} never produced`);
    else if (ids.has(run.captured[name])) fail(`${rowsKey} must exclude ${name}`);
  }
  if (a.firstResultIsCaptured) {
    const first = (obj.results as Record<string, unknown>[] | undefined)?.[0]?.id;
    if (!(a.firstResultIsCaptured in run.captured) || first !== run.captured[a.firstResultIsCaptured]) {
      fail(`results[0].id ${show(first)} != ${a.firstResultIsCaptured}=${show(run.captured[a.firstResultIsCaptured])}`);
    }
  }
  if (step.capture && !(step.capture.as in run.captured)) fail(`capture ${step.capture.as} (${step.capture.path}) not produced`);
  return errors;
}
