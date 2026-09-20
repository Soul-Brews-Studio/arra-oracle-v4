/**
 * Shared harness for the #59 context tests.
 *
 * Thin on purpose. The dataset is built by the EXISTING frozen bare taxonomy
 * fixture, and children run through the EXISTING bounded helpers. There is no
 * second Python creator and no unbounded launch here: a rival creator would
 * become a second description of the nineteen tables and drift from the real
 * one the moment either changed.
 *
 * Bounded-claim reminder: the gate is a cooperative operator protocol, SDK
 * readback is not power-loss proof, and nothing here defends against same-UID
 * code that takes the SDK and declines the gate.
 */

import { createTaxonomyFixture } from "./taxonomy-fixture";

export type ContextFixture = {
  datasetRoot: string;
  workspaces: Record<string, { workspace_id: string }>;
  cleanup: () => Promise<void>;
};

/** A fresh nineteen-table dataset seeded with `workspaces` only. */
export async function createContextFixture(
  workspaces: string[] = ["alpha-workspace", "beta-workspace"],
): Promise<ContextFixture> {
  return createTaxonomyFixture(workspaces);
}

/** Strict JSON request bytes, the only entrypoint shape the kernel accepts. */
export function encodeRequest(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
export const contextId = pad;

/** Overrides spread LAST, so any field including an invalid one can be forced. */
export function peerRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { workspace_name: workspace, peer_id: pad("peer1"), name: "peer-a", ...overrides };
}

export function sessionRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { workspace_name: workspace, session_id: pad("sess1"), name: "sess-a", ...overrides };
}

export function joinRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { workspace_name: workspace, session_name: "sess-a", peer_name: "peer-a", ...overrides };
}

/**
 * One batch item.
 *
 * `source` uses the CODEC's key names -- source_message_id, source_created_at,
 * supplied_digest -- not the abbreviations an early draft used. The governed
 * parser rejects the abbreviated shape, so building it here would hand every
 * lane a parse error instead of the case they meant to test.
 */
export function messageItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { message, ...rest } = overrides as { message?: Record<string, unknown> };
  return {
    public_id: pad("msg1"),
    message: {
      peer_name: "peer-a",
      role: null,
      content: "hello",
      in_reply_to: null,
      ...(message ?? {}),
    },
    source: null,
    ...rest,
  };
}

export function sourcedItem(
  sourceMessageId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return messageItem({
    source: {
      source_message_id: sourceMessageId,
      source_created_at: null,
      supplied_digest: null,
    },
    ...overrides,
  });
}

export function appendRequest(
  workspace: string,
  session: string,
  items: Record<string, unknown>[],
): Record<string, unknown> {
  return { workspace_name: workspace, session_name: session, items };
}
