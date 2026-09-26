/**
 * Session-script and v3-output-shape loading for the v3-compat-v1 fixture
 * family (slice VA, `docs/overnight/V3-PARITY.md` §7/§8).
 *
 * Split out of `test/mcp-v3-acceptance.test.ts` to keep that file under the
 * repo's 350-500 line-per-file guidance (`V3-PARITY.md` §7 "Nat's style").
 * Pure data shapes and one shape matcher; no HTTP, no process, no state.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Provenance = { sessionId: string; seq: number; timestamp: string; tool: string; note: string };

export type As = "rw" | "ro" | "other";

/** Pointer at another step's resolved argument, by that step's stable `ref`. */
export type StepArgRef = { stepRef: string; path: string };

export type StepAssert = {
  kind:
    | "tools_list_gate"
    | "listed_and_ok"
    | "isError_code"
    | "isError_generic"
    | "not_listed_403"
    | "alias_matches";
  notes: string;
  shape?: string;
  /** Which key of the shape file to match; defaults to `PRIMARY_KEY[shape]`. */
  shapeKey?: string;
  errorCode?: string;
  expectListed?: string[];
  expectAbsent?: string[];
  /** Every advertised `oracle_*` / `____*` / `arra_*` name is one of `session.carried`. */
  expectOnlyCarriedV3?: boolean;
  includesCaptured?: string[];
  excludesCaptured?: string[];
  /** Row array and id key for `includesCaptured` (defaults: first present of
   *  documents/traces/results/threads/files, and `id`). */
  rowsKey?: string;
  idKey?: string;
  firstResultIsCaptured?: string;
  expectFields?: Record<string, unknown>;
  expectFieldsFromCapture?: Record<string, string>;
  expectFieldsFromStepArgs?: Record<string, StepArgRef>;
  expectFirstFileFromStepArgs?: { field: string } & StepArgRef;
  expectMessagesFromStepArgs?: StepArgRef[];
  expectNanoid21Field?: string;
  expectSummary?: Record<string, unknown>;
  expectStringField?: string;
  expectMessageCount?: number;
  expectMinTotalDocuments?: number;
  expectEmptyResults?: boolean;
  metadataEquals?: Record<string, unknown>;
  aliasOf?: string;
  compareToStepRef?: string;
  neverListed?: boolean;
  compareToUnknownTool?: string;
  assertNoSpawn?: boolean;
};

/** A step is GAP unless every gate tool is advertised to its principal. */
export type Gate = { as: As; tool: string };

export type Step = {
  step: number;
  /** Stable name other steps use to point at this one. */
  ref?: string;
  slice: string;
  as: As;
  peer?: string;
  method: "tools/list" | "tools/call";
  tool?: string;
  arguments?: unknown;
  gate?: Gate[];
  provenance: Provenance[];
  provenanceNote?: string;
  assert: StepAssert;
  capture?: { as: string; path: string };
};

export type SessionScript = {
  version: string;
  principals: Record<As, { workspace: string; actions: string[]; peers?: string[] }>;
  notCarried: string[];
  carried: string[];
  steps: Step[];
};

export const FIXTURES_DIR = new URL("../fixtures/v3-compat-v1/", import.meta.url).pathname;

export function loadSession(): SessionScript {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "sessions", "v3-session-01.json"), "utf-8"));
}

export type ShapeField = {
  type?: string | string[];
  optional?: boolean;
  nullable?: boolean;
  const?: unknown;
  enum?: unknown[];
  /** A sibling definition name, or an inline map of field -> spec/type text. */
  shape?: string | Record<string, unknown>;
  /** For arrays: a sibling definition name every element must match. */
  items?: string;
};

export function loadShape(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "shapes", `${name}.json`), "utf-8"));
}

/** Which key inside each shape file is "the normal 200 response". */
export const PRIMARY_KEY: Record<string, string> = {
  oracle_search: "topLevel",
  oracle_learn: "success",
  oracle_handoff: "success",
  oracle_read: "found",
  oracle_list: "topLevel",
  oracle_supersede: "success",
  oracle_inbox: "topLevel",
  oracle_trace: "success",
  oracle_trace_get: "success",
  oracle_trace_list: "topLevel",
  oracle_trace_distill: "success",
  oracle_thread: "success",
  oracle_threads: "topLevel",
  oracle_thread_read: "topLevel",
  oracle_stats: "topLevel",
  oracle_concepts: "topLevel",
  "compat-error": "shape",
};

/** V3-PARITY.md §2.5: the closed warning-code set. */
export const WARNING_CODES = [
  "field_unavailable",
  "argument_ignored",
  "semantic_change",
  "order_changed",
  "partial",
  "truncated",
] as const;

/** `"string|null"`, `"string[]"`, or a full spec object -> a spec object. */
function normalize(spec: unknown): ShapeField {
  if (typeof spec !== "string") return spec as ShapeField;
  const parts = spec.split("|");
  const nullable = parts.includes("null");
  const types = parts.filter((p) => p !== "null").map((p) => (p.endsWith("[]") ? "array" : p));
  return { type: types.length === 1 ? types[0] : types, nullable };
}

const typeOf = (v: unknown): string => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

/**
 * Validate the top-level `compat_warnings` (if any) and return the field
 * names they declare. A malformed warning is itself a shape error.
 */
function readWarnings(obj: Record<string, unknown>, errors: string[]): Set<string> {
  const named = new Set<string>();
  if (!("compat_warnings" in obj)) return named;
  const list = obj.compat_warnings;
  if (!Array.isArray(list)) {
    errors.push(".compat_warnings: expected array");
    return named;
  }
  list.forEach((w, i) => {
    const warning = w as { code?: unknown; field?: unknown; detail?: unknown } | null;
    if (typeof warning !== "object" || warning === null) return void errors.push(`.compat_warnings[${i}]: expected object`);
    if (!(WARNING_CODES as readonly unknown[]).includes(warning.code)) {
      errors.push(`.compat_warnings[${i}].code: ${JSON.stringify(warning.code)} not in the closed set`);
    }
    if (typeof warning.field !== "string") errors.push(`.compat_warnings[${i}].field: expected string`);
    else named.add(warning.field);
    if (typeof warning.detail !== "string") errors.push(`.compat_warnings[${i}].detail: expected string`);
  });
  return named;
}

type Ctx = { defs: Record<string, unknown>; warned: Set<string>; errors: string[] };

/** `a.b[].c` style path, and the forms a warning may use to name it. */
const warnedFor = (ctx: Ctx, path: string, key: string) =>
  ctx.warned.has(path) || ctx.warned.has(key) || ctx.warned.has(path.replace(/\[\d+\]/g, "[]"));

function checkObject(value: unknown, fields: Record<string, unknown>, path: string, ctx: Ctx): void {
  if (typeOf(value) !== "object") return void ctx.errors.push(`${path || "."}: expected an object, got ${JSON.stringify(value)}`);
  const obj = value as Record<string, unknown>;
  for (const [key, raw] of Object.entries(fields)) {
    const spec = normalize(raw);
    const at = path ? `${path}.${key}` : key;
    const present = key in obj && obj[key] !== undefined;
    if (!present) {
      if (!spec.optional) ctx.errors.push(`.${at}: missing (removals are never silent, §2.5)`);
      continue;
    }
    const v = obj[key];
    if (v === null) {
      // §2.5: a field v4 cannot fill is present as null AND named in compat_warnings.
      if (!spec.nullable && spec.type !== "null" && !warnedFor(ctx, at, key)) {
        ctx.errors.push(`.${at}: null but not nullable, and not named in compat_warnings`);
      }
      continue;
    }
    if (spec.const !== undefined && v !== spec.const) {
      ctx.errors.push(`.${at}: expected ${JSON.stringify(spec.const)}, got ${JSON.stringify(v)}`);
    }
    if (spec.enum && !spec.enum.includes(v)) ctx.errors.push(`.${at}: ${JSON.stringify(v)} not in ${JSON.stringify(spec.enum)}`);
    const types = spec.type === undefined ? [] : Array.isArray(spec.type) ? spec.type : [spec.type];
    if (types.length > 0 && !types.includes(typeOf(v))) {
      ctx.errors.push(`.${at}: expected ${types.join("|")}, got ${typeOf(v)}`);
      continue;
    }
    if (typeof spec.shape === "string" && typeof ctx.defs[spec.shape] === "object") {
      checkObject(v, ctx.defs[spec.shape] as Record<string, unknown>, at, ctx);
    } else if (spec.shape && typeof spec.shape === "object") {
      checkObject(v, spec.shape, at, ctx);
    }
    if (Array.isArray(v) && typeof spec.items === "string" && typeof ctx.defs[spec.items] === "object") {
      v.forEach((item, i) => checkObject(item, ctx.defs[spec.items!] as Record<string, unknown>, `${at}[${i}]`, ctx));
    }
  }
}

/**
 * Key/type check against a v3 shape, one level into nested objects and array
 * items (via `shape`/`items` references to sibling definitions in the same
 * shape file). Extra keys are allowed (§2.5: `compat_warnings`, `v4`, and the
 * additions each tool's design names).
 */
export function matchesShape(value: unknown, fields: Record<string, unknown>, defs: Record<string, unknown> = {}): string[] {
  const errors: string[] = [];
  if (typeOf(value) !== "object") return [`expected an object, got ${JSON.stringify(value)}`];
  const warned = readWarnings(value as Record<string, unknown>, errors);
  checkObject(value, fields, "", { defs, warned, errors });
  return errors;
}
