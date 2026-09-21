/**
 * Shared harness for the session-link kernel smoke test.
 *
 * Thin by design, and BARE: the dataset comes from the accepted bare/context
 * fixture, exactly as the read-cursor helper does. A lane that needs a real
 * peer or session registers them through the REAL context API inside its own
 * gated child.
 */

import { createContextFixture } from "./context-fixture";

export type SessionLinkFixture = {
  datasetRoot: string;
  workspaces: Record<string, { workspace_id: string }>;
  cleanup: () => Promise<void>;
};

export async function createSessionLinkFixture(
  workspaces: string[] = ["alpha-workspace"],
): Promise<SessionLinkFixture> {
  return createContextFixture(workspaces);
}

/** nanoid21 shaped ids, deterministic per seed. */
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
export const sessionLinkId = pad;

export function createSessionLinkRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: pad("link1"),
    workspace_name: workspace,
    from_session_name: "sess-a",
    to_session_name: "sess-b",
    relation: "continues",
    evidence_ref: null,
    created_by_peer_name: null,
    ...overrides,
  };
}

export function listSessionLinksRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    session_name: "sess-a",
    direction: "from",
    cursor: null,
    limit: 10,
    ...overrides,
  };
}
