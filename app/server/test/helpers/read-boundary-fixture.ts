/**
 * Shared seed for the #87 read-boundary lanes (R3, docs/overnight/DECISIONS.md).
 *
 * Two workspaces with COLLIDING identity on purpose -- the same session names
 * and the same message public_id in both -- so a read that dropped its
 * workspace clause, or consulted the other workspace's membership, returns a
 * visibly wrong row instead of passing silently.
 *
 *   alpha  sess-main    peer-a (current)                 "main-alpha"   by peer-a
 *          sess-secret  peer-b (current), peer-c (LEFT)  "SECRET-alpha" by peer-b
 *   beta   sess-main    peer-b (current)                 "main-beta"    by peer-b
 *          sess-secret  peer-a (current)                 "SECRET-beta"  by peer-a
 *
 * peer-a is a current member of `sess-secret` in BETA and of nothing secret in
 * ALPHA: that is the cross-workspace membership collision. peer-c's departure
 * is staged with the existing gated raw connection (`raw-mutate.ts`), because
 * no product operation sets `left_at` -- setup, never an oracle.
 *
 * Real gated children and a fresh mkdtemp dataset; nothing is mocked.
 */

import { appendRequest, contextId, createContextFixture, messageItem, type ContextFixture } from "./context-fixture";
import { runGated } from "./publication-fixture";

export const ALPHA = "alpha-workspace";
export const BETA = "beta-workspace";
export const MAIN_ID = contextId("rb-main");
export const SECRET_ID = contextId("rb-secret");

/** The transport-built authority shapes the kernel takes (R3). */
export const READER = Object.freeze({ operator: false, peers: null });
export const OPERATOR = Object.freeze({ operator: true, peers: null });
export const bound = (peers: string[], operator = false) => Object.freeze({ operator, peers });

const CONTEXT_CHILD = new URL("../fixtures/context-v1/core/gated-context.ts", import.meta.url).pathname;
const RAW_MUTATE = new URL("../fixtures/context-v1/ownership/raw-mutate.ts", import.meta.url).pathname;
const CLOCK_MS = Date.parse("2026-09-21T00:00:00.000Z");

export type BoundaryOp = { method: string; request: unknown; authority?: unknown };

export const op = (method: string, request: unknown, authority?: unknown): BoundaryOp =>
  authority === undefined ? { method, request } : { method, request, authority };

/** One gated context child; returns its single JSON result line. */
export async function driveContext(root: string, ops: BoundaryOp[]): Promise<Record<string, any>> {
  const result = await runGated(root, CONTEXT_CHILD, [root, JSON.stringify({ ops, clockMs: CLOCK_MS })]);
  if (result.code !== 0) throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 900)}`);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output: ${result.stderr.slice(0, 900)}`);
  return JSON.parse(line);
}

type Layout = {
  joins: Array<[session: string, peer: string]>;
  messages: Array<[session: string, publicId: string, peer: string, content: string]>;
};

const LAYOUT: Record<string, Layout> = {
  [ALPHA]: {
    joins: [["sess-main", "peer-a"], ["sess-secret", "peer-b"], ["sess-secret", "peer-c"]],
    messages: [["sess-main", MAIN_ID, "peer-a", "main-alpha"], ["sess-secret", SECRET_ID, "peer-b", "SECRET-alpha"]],
  },
  [BETA]: {
    joins: [["sess-main", "peer-b"], ["sess-secret", "peer-a"]],
    messages: [["sess-main", MAIN_ID, "peer-b", "main-beta"], ["sess-secret", SECRET_ID, "peer-a", "SECRET-beta"]],
  },
};

function seedOps(): BoundaryOp[] {
  const ops: BoundaryOp[] = [];
  for (const [workspace, layout] of Object.entries(LAYOUT)) {
    for (const name of ["peer-a", "peer-b", "peer-c"]) {
      ops.push(op("registerPeer", { workspace_name: workspace, peer_id: contextId(name), name }));
    }
    for (const name of ["sess-main", "sess-secret"]) {
      ops.push(op("registerSession", { workspace_name: workspace, session_id: contextId(name), name }));
    }
    for (const [session, peer] of layout.joins) {
      ops.push(op("joinSession", { workspace_name: workspace, session_name: session, peer_name: peer }));
    }
    for (const [session, publicId, peer, content] of layout.messages) {
      const item = messageItem({ public_id: publicId, message: { peer_name: peer, content } });
      ops.push(op("appendMessages", appendRequest(workspace, session, [item])));
    }
  }
  return ops;
}

/** A fresh two-workspace dataset in the layout above, peer-c already departed. */
export async function createReadBoundaryFixture(): Promise<ContextFixture> {
  const fixture = await createContextFixture([ALPHA, BETA]);
  try {
    const ops = seedOps();
    const seeded = await driveContext(fixture.datasetRoot, ops);
    for (let i = 0; i < ops.length; i++) {
      const result = seeded[`op${i}`];
      if (result?.ok !== true) throw new Error(`seed op${i} ${ops[i]!.method} failed: ${JSON.stringify(result)}`);
      const value = result.value as { outcome?: string };
      if (value?.outcome !== undefined && !["created", "complete"].includes(value.outcome)) {
        throw new Error(`seed op${i} ${ops[i]!.method} did not apply: ${JSON.stringify(value)}`);
      }
    }
    const left = await runGated(fixture.datasetRoot, RAW_MUTATE, [
      "leave-membership",
      fixture.datasetRoot,
      ALPHA,
      "sess-secret",
      "peer-c",
    ]);
    if (left.code !== 0 || !left.stdout.includes("EVENT raw:left rows=")) {
      throw new Error(`staging peer-c's departure failed: ${left.stderr.slice(0, 600)}`);
    }
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
  return fixture;
}
