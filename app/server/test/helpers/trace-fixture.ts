/**
 * Minimal harness for the #28 trace kernel smoke test.
 *
 * Thin by design, mirroring `read-cursor-fixture.ts`: the dataset comes from
 * the existing bare context fixture (already carries `traces` /
 * `trace_hits`, per storage.ts's TARGET_SCHEMA), seeded with workspaces only.
 */

import { createContextFixture } from "./context-fixture";

export type TraceFixture = {
  datasetRoot: string;
  workspaces: Record<string, { workspace_id: string }>;
  cleanup: () => Promise<void>;
};

export async function createTraceFixture(
  workspaces: string[] = ["alpha-workspace"],
): Promise<TraceFixture> {
  return createContextFixture(workspaces);
}

/** nanoid21-shaped ids, deterministic per seed. */
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
export const traceId = pad;

export function hitInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "url",
    target: { url: "https://example.com/a" },
    ref: "citation-1",
    line_start: null,
    line_end: null,
    excerpt: null,
    content_hash: null,
    captured_at: null,
    note: null,
    ...overrides,
  };
}

export function createTraceRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    id: pad("trace1"),
    name: "trace-a",
    session_name: null,
    peer_name: null,
    query: "find the bug",
    mode: null,
    session_id: null,
    session_from_ts: null,
    session_to_ts: null,
    friction_score: null,
    confidence: null,
    parent_id: null,
    prev_id: null,
    depth: "0",
    status: "open",
    h_metadata: null,
    internal_metadata: null,
    hits: [],
    ...overrides,
  };
}
