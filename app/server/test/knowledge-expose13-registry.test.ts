// #31 overnight R7/R8 (issues #28, #29, #30, #31): registry data-shape proof.
//
// registry.ts:18-35 used to say, in so many words, that the session-link,
// trace, lifecycle and search-chunk kernels are DELIBERATELY unreachable —
// `KNOWLEDGE_METHODS` (registry.ts:90-196) had no entry for any of the 13
// facade methods those kernels expose, so HTTP answered 404 and no `kb_*`
// tool existed for them (see `.tmp/understand/issue-31/repro.ts`'s measured
// `UNEXPOSED` list). This file pins the pure, no-dataset half of "fixed":
// the registry names all 13, with the action R8 assigns each one, and every
// downstream table that is DERIVED from the registry (the `kb_*` MCP
// catalogue, the tool -> action map) picks them up automatically, with no
// second list to edit. `knowledge-expose13-transport.test.ts` and
// `knowledge-expose13-live.test.ts` prove the wire and dataset halves.
//
// No LanceDB dataset, no HTTP server, no gate: pure imports only, so this
// file is fast and was RED before the registry.ts change (KNOWLEDGE_METHODS
// had no entry for any of the 13 names below).

import { describe, expect, test } from "bun:test";
import { KNOWLEDGE_METHODS, KNOWLEDGE_METHOD_NAMES } from "../src/knowledge/registry";
import { KNOWLEDGE_TOOLS, TOOL_NAMES } from "../src/mcp/tools";

/** #31 R7/R8: the 13 methods this slice exposes, and the action R7/R8 assign
 *  each one. Reads -> content:read. Writes -> content:write. Ordinary
 *  create/mutate writes AND the three explicitly named in R8
 *  (indexRevisionChunks, reconcileSearchChunks, writeChunkEmbedding) are all
 *  content:write — none of the 13 is audit-only or internal-only. */
const EXPECTED: Readonly<Record<string, "content:read" | "content:write">> = Object.freeze({
  // #28 session links
  listSessionLinks: "content:read",
  createSessionLink: "content:write",
  // #28 traces
  getTrace: "content:read",
  listTraceHits: "content:read",
  createTrace: "content:write",
  // #29 node lifecycle
  getRecallEligibility: "content:read",
  listLifecycleHistory: "content:read",
  retireNode: "content:write",
  supersedeNode: "content:write",
  // #30 search chunks
  listSearchChunks: "content:read",
  indexRevisionChunks: "content:write",
  writeChunkEmbedding: "content:write",
  reconcileSearchChunks: "content:write",
});

const EXPECTED_NAMES = Object.keys(EXPECTED);

describe("registry: the 13 previously-excluded methods are now named", () => {
  test("KNOWLEDGE_METHOD_NAMES includes every one of the 13", () => {
    for (const name of EXPECTED_NAMES) {
      expect(KNOWLEDGE_METHOD_NAMES).toContain(name);
    }
  });

  test("each one carries the action R7/R8 assigns it, and is a write method iff content:write", () => {
    for (const [name, action] of Object.entries(EXPECTED)) {
      const entry = KNOWLEDGE_METHODS[name];
      expect(entry, `registry has no entry for ${name}`).toBeDefined();
      expect(entry!.action).toBe(action);
      expect(typeof entry!.call).toBe("function");
    }
  });

  test("no entry among the 13 is scoped anywhere but the request root", () => {
    // Every parser checked for this slice (session-link.ts, trace.ts,
    // lifecycle.ts, search-chunk.ts) carries `workspace_name` at the request
    // root, unlike `publishRevision`'s `["content"]`. A non-empty scopePath
    // here would mean the transport peeks the wrong place for the scope
    // carrier and every request would 400 before ever reaching the parser.
    for (const name of EXPECTED_NAMES) {
      expect(KNOWLEDGE_METHODS[name]!.scopePath).toEqual([]);
    }
  });

  test("none of the 13 is marked ephemeralWrite (only answerChat is)", () => {
    for (const name of EXPECTED_NAMES) {
      expect(KNOWLEDGE_METHODS[name]!.ephemeralWrite).not.toBe(true);
    }
  });
});

describe("MCP catalogue and tool->action map are DERIVED from the registry, not a second list", () => {
  test("KNOWLEDGE_TOOLS (tools.ts) has a kb_<method> entry for each of the 13", () => {
    const names = KNOWLEDGE_TOOLS.map((t) => t.name);
    for (const method of EXPECTED_NAMES) {
      expect(names).toContain(`kb_${method}`);
    }
  });

  test("TOOL_NAMES (the full catalogue) includes every kb_<method> for the 13", () => {
    for (const method of EXPECTED_NAMES) {
      expect(TOOL_NAMES).toContain(`kb_${method}`);
    }
  });
});
