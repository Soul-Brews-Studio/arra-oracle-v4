/**
 * Session-script and v3-output-shape loading for the v3-compat-v1 fixture
 * family (slice VA, `docs/overnight/V3-PARITY.md` §7/§8).
 *
 * Split out of `test/mcp-v3-acceptance.test.ts` to keep that file under the
 * repo's 350-500 line-per-file guidance (`V3-PARITY.md` §7 "Nat's style").
 * Pure data shapes and one flat-shape matcher; no HTTP, no process, no state.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Provenance = { sessionId: string; seq: number; timestamp: string; tool: string; note: string };

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
  errorCode?: string;
  expectListed?: string[];
  expectAbsent?: string[];
  includesCaptured?: string[];
  excludesCaptured?: string[];
  firstResultIsCaptured?: string;
  firstFileIsCaptured?: string;
  expectFieldsPresent?: string[];
  expectFields?: Record<string, unknown>;
  expectSummary?: Record<string, unknown>;
  expectStringField?: string;
  expectMessageCount?: number;
  expectMinTotalDocuments?: number;
  expectEmptyResults?: boolean;
  metadataEquals?: Record<string, unknown>;
  aliasOf?: string;
  compareToStep?: number;
  neverListed?: boolean;
  compareToUnknownTool?: string;
  assertNoSpawn?: boolean;
};

export type Step = {
  step: number;
  slice: string;
  as: "rw" | "ro" | "other";
  peer?: string;
  method: "tools/list" | "tools/call";
  tool?: string;
  arguments?: unknown;
  provenance: Provenance[];
  assert: StepAssert;
  capture?: { as: string; path: string };
};

export type SessionScript = {
  version: string;
  principals: Record<string, { workspace: string; actions: string[]; peer?: string }>;
  notCarried: string[];
  steps: Step[];
};

export const FIXTURES_DIR = new URL("../fixtures/v3-compat-v1/", import.meta.url).pathname;

export function loadSession(): SessionScript {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "sessions", "v3-session-01.json"), "utf-8"));
}

export type ShapeField = {
  type?: string;
  optional?: boolean;
  nullable?: boolean;
  const?: unknown;
  enum?: unknown[];
};

export function loadShape(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, "shapes", `${name}.json`), "utf-8"));
}

/** Which key inside each shape file is "the normal 200 response" to check a
 *  `listed_and_ok` step's returned value against. Nested array items (e.g.
 *  `results[]`, `documents[]`) are each V-slice's own failing-first test's job
 *  (`V3-PARITY.md` §7) -- this harness checks the wire-level envelope. */
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
  oracle_thread: "success",
  oracle_thread_read: "topLevel",
  oracle_stats: "topLevel",
};

/** A flat key/type check -- deliberately not recursive into nested arrays;
 *  see the PRIMARY_KEY comment above for why. */
export function matchesShape(value: unknown, fields: Record<string, ShapeField>): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [`expected an object, got ${JSON.stringify(value)}`];
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const [key, spec] of Object.entries(fields)) {
    const present = key in obj && obj[key] !== undefined;
    if (!present) {
      if (!spec.optional) errors.push(`.${key}: missing`);
      continue;
    }
    const v = obj[key];
    if (v === null) {
      if (!spec.nullable) errors.push(`.${key}: null but not nullable`);
      continue;
    }
    if (spec.const !== undefined && v !== spec.const) {
      errors.push(`.${key}: expected ${JSON.stringify(spec.const)}, got ${JSON.stringify(v)}`);
    }
    if (spec.enum && !spec.enum.includes(v)) {
      errors.push(`.${key}: ${JSON.stringify(v)} not in ${JSON.stringify(spec.enum)}`);
    }
    if (spec.type === "array" && !Array.isArray(v)) errors.push(`.${key}: expected array`);
    else if (spec.type === "object" && (typeof v !== "object" || Array.isArray(v))) errors.push(`.${key}: expected object`);
    else if (spec.type && spec.type !== "array" && spec.type !== "object" && spec.type !== "null" && typeof v !== spec.type) {
      errors.push(`.${key}: expected ${spec.type}, got ${typeof v}`);
    }
  }
  return errors;
}
