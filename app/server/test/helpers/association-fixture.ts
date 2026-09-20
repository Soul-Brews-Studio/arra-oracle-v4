/**
 * Shared harness for the #65 association tests.
 *
 * Thin by design: the dataset comes from the ACCEPTED bare/context fixture and
 * children run through the EXISTING bounded helpers. No second Python creator
 * -- a rival creator becomes a second description of the nineteen tables and
 * drifts from the real one the moment either changes.
 */

import { createContextFixture } from "./context-fixture";

/**
 * The published shape: the accepted BARE/context fixture, workspace rows only.
 *
 * This is a SHARED commitment other lanes have already built against. An
 * earlier revision of this file quietly switched it to the publication fixture
 * so core tests could reach seeded terms -- which also seeds the reserved
 * vocabularies, and would have collided with the ownership lane's own
 * seedReserved setup before its evidence tests ever ran. Redefining a shared
 * helper to satisfy one lane's tests is the wrong direction: a core test that
 * needs a richer dataset imports the accepted publication fixture directly.
 */
export type AssociationFixture = {
  datasetRoot: string;
  workspaces: Record<string, { workspace_id: string }>;
  cleanup: () => Promise<void>;
};

export async function createAssociationFixture(
  workspaces: string[] = ["alpha-workspace", "beta-workspace"],
): Promise<AssociationFixture> {
  return createContextFixture(workspaces);
}

export function encodeRequest(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
export const assocId = pad;

/** Overrides spread LAST, so any field including an invalid one can be forced. */
export function getAssociationsRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { workspace_name: workspace, node_id: pad("node1"), revision_id: null, ...overrides };
}

export function reconcileRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  // revision_id is REQUIRED nonnull here, unlike the read.
  return { workspace_name: workspace, node_id: pad("node1"), revision_id: pad("rev1"), ...overrides };
}

export function scanRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    target_kind: "trace",
    target: { trace_id: pad("trace1") },
    revision_mode: "current",
    limit: 10,
    cursor: null,
    ...overrides,
  };
}

export function scanCursor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_name: "alpha-workspace",
    target_kind: "trace",
    target_key: "unset",
    revision_mode: "current",
    nodes_version: "1",
    node_id: pad("node1"),
    revision_no: null,
    position: null,
    ...overrides,
  };
}
