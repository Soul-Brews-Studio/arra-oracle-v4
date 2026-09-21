/**
 * Shared harness for the #71 read-cursor tests.
 *
 * Thin by design, and BARE: the dataset comes from the accepted bare/context
 * fixture, so this helper seeds workspaces only. A lane that needs a real
 * peer, session or message registers them through the REAL context API inside
 * its own gated child, or imports the accepted publication fixture directly
 * for a pre-seeded `message_public_id`.
 *
 * This shape is a published commitment other lanes author against. Do not
 * redefine it to suit one lane's setup: a richer dataset is reached by
 * importing the accepted fixture that already provides it, never by changing
 * what this helper returns underneath lanes that already built on it.
 */

import { createContextFixture } from "./context-fixture";

export type ReadCursorFixture = {
  datasetRoot: string;
  workspaces: Record<string, { workspace_id: string }>;
  cleanup: () => Promise<void>;
};

export async function createReadCursorFixture(
  workspaces: string[] = ["alpha-workspace", "beta-workspace"],
): Promise<ReadCursorFixture> {
  return createContextFixture(workspaces);
}

/** Strict JSON request bytes, the only entrypoint shape the kernel accepts. */
export function encodeRequest(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** nanoid21 shaped ids, deterministic per seed. */
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
export const cursorId = pad;

/**
 * Defaults match the accepted context fixture's own peer/session names, so a
 * lane can register with `peerRequest`/`sessionRequest` and then address the
 * cursor without restating identities.
 */
export function getReadCursorRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { workspace_name: workspace, peer_name: "peer-a", session_name: "sess-a", ...overrides };
}

/**
 * `expected` is REQUIRED and closed:
 *   null                               -> the row must be ABSENT
 *   { last_read_message_id: null }     -> present row, null POINTER
 *   { last_read_message_id: <N> }      -> present row, that exact pointer
 * These are three distinct prior states; the default here is the absent one.
 */
export function advanceReadCursorRequest(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_name: workspace,
    peer_name: "peer-a",
    session_name: "sess-a",
    last_read_message_id: pad("msg1"),
    expected: null,
    ...overrides,
  };
}

/** The present-row guard, for both the null-pointer and nonnull-pointer forms. */
export function expectedPointer(pointer: string | null): Record<string, unknown> {
  return { last_read_message_id: pointer };
}

/** The exact physical field order a stored cursor row must present. */
export const READ_CURSOR_FIELDS = [
  "workspace_name",
  "peer_name",
  "session_name",
  "last_read_message_id",
  "last_read_at",
] as const;
