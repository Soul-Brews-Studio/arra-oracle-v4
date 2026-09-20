/**
 * #26 publication service: real persistence against a seeded target19 copy.
 *
 * Every dataset here is created by the Python exporter into a scratch
 * directory this test owns and removes. Writers run inside the real writer
 * gate via an exec'd child, so the gate is exercised rather than mocked.
 *
 * Bounded claims, stated once: the lock is a cooperative operator protocol,
 * not multiwriter CAS; SDK readback proves committed table state, not
 * power-loss durability; and none of this defends against same-UID code that
 * imports the SDK directly and declines to take the gate.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createFixture,
  encodeRequest,
  revisionEnvelope,
  runGated,
  type Fixture,
  type SeededWorkspace,
} from "./helpers/publication-fixture";
import { openPublicationReader } from "../src/publication/service";

const CHILD = new URL("./fixtures/publication-v1/gated-publish.ts", import.meta.url).pathname;
const ALPHA = "alpha-workspace";
const BETA = "beta-workspace";
/** A fixed instant; nothing here reads a real clock. */
const CLOCK_MS = Date.parse("2026-09-20T12:00:00.000Z");

let fixture: Fixture;
let alpha: SeededWorkspace;
let beta: SeededWorkspace;

const nodeId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);
const revId = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

async function publish(
  request: unknown,
  revisionIds: string[],
  options: { clockMs?: number } = {},
): Promise<{ ok: boolean; outcome?: Record<string, unknown>; code?: string | null }> {
  const result = await runGated(fixture.datasetRoot, CHILD, [
    fixture.datasetRoot,
    JSON.stringify({ request, revisionIds, clockMs: options.clockMs ?? CLOCK_MS }),
  ]);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 400)}`);
  return JSON.parse(line);
}

beforeAll(async () => {
  fixture = await createFixture([ALPHA, BETA]);
  alpha = fixture.workspaces[ALPHA]!;
  beta = fixture.workspaces[BETA]!;
}, 180_000);

afterAll(async () => {
  await fixture?.cleanup();
});

describe("the dataset the tests actually run against", () => {
  test("the exporter seeded two workspaces with distinct identifiers", () => {
    expect(alpha.workspace_id).not.toBe(beta.workspace_id);
    expect(alpha.term_ids.type.note.id).not.toBe(beta.term_ids.type.note.id);
    expect(alpha.session_name).not.toBe(beta.session_name);
  });

  test("a reader opens the seeded dataset and reports an absent node as exactly null", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const absent = await reader.getAcceptedHead(
      encodeRequest({ workspace_name: ALPHA, node_id: nodeId("absentnode") }),
    );
    expect(absent).toBeNull();
  });
});

describe("first-node publication round trip", () => {
  test("a first revision creates a headed node and reads back exactly", async () => {
    const node = nodeId("firstnodeA");
    const revision = revId("firstrevA");
    const result = await publish(
      { operation_id: "op-first-a", content: revisionEnvelope(ALPHA, alpha, node) },
      [revision],
    );
    expect(result.ok).toBe(true);
    const outcome = result.outcome!;
    expect(outcome.outcome).toBe("accepted");
    expect(outcome.node_id).toBe(node);
    expect(outcome.revision_id).toBe(revision);
    // Int64 ordinal travels as canonical decimal TEXT, never a JS number.
    expect(outcome.revision_no).toBe("1");
    expect(typeof outcome.content_digest).toBe("string");

    const reader = await openPublicationReader(fixture.datasetRoot);
    const head = (await reader.getAcceptedHead(
      encodeRequest({ workspace_name: ALPHA, node_id: node }),
    )) as { node: Record<string, unknown>; revision: Record<string, unknown> };
    expect(head).not.toBeNull();
    expect(head.node.id).toBe(node);
    expect(head.node.current_revision_id).toBe(revision);
    expect(head.revision.id).toBe(revision);
    expect(head.revision.revision_no).toBe("1");
    expect(head.revision.base_revision_id).toBeNull();
    // Node timestamps come from the stored revision, not a second sample.
    expect(head.node.created_at).toBe(head.revision.created_at);
    // The five JSON columns stay as stored canonical STRINGS.
    expect(typeof head.revision.term_snapshot_json).toBe("string");
    expect(head.revision.link_snapshot_json).toBe("[]");
  }, 180_000);

  test("history for a single revision is exactly one row, oldest first", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    const history = (await reader.listAcceptedHistory(
      encodeRequest({ workspace_name: ALPHA, node_id: nodeId("firstnodeA") }),
    )) as { snapshot_head_revision_id: string; revisions: Record<string, unknown>[] };
    expect(history.revisions).toHaveLength(1);
    expect(history.snapshot_head_revision_id).toBe(revId("firstrevA"));
    expect(history.revisions[0]!.revision_no).toBe("1");
  });
});

describe("replay and collision matrix", () => {
  test("the same operation replayed returns the ORIGINAL accepted values", async () => {
    const node = nodeId("replaynodeA");
    const revision = revId("replayrevA");
    const request = { operation_id: "op-replay-a", content: revisionEnvelope(ALPHA, alpha, node) };
    const first = await publish(request, [revision]);
    expect(first.outcome!.outcome).toBe("accepted");

    // A different id source and a LATER clock: an idempotent replay must
    // return the original allocation, not re-time or re-allocate it.
    const replay = await publish(request, [revId("shouldnotuse")], { clockMs: CLOCK_MS + 86_400_000 });
    expect(replay.outcome!.outcome).toBe("idempotent");
    expect(replay.outcome!.revision_id).toBe(revision);
    expect(replay.outcome!.revision_no).toBe(first.outcome!.revision_no);
    expect(replay.outcome!.revision_created_at).toBe(first.outcome!.revision_created_at);
  }, 180_000);

  test("the same operation with a CHANGED payload is an operation_digest conflict", async () => {
    const node = nodeId("digestnodeA");
    const base = revisionEnvelope(ALPHA, alpha, node);
    await publish({ operation_id: "op-digest-a", content: base }, [revId("digestrevA")]);
    const changed = await publish(
      { operation_id: "op-digest-a", content: { ...base, title: "a different title" } },
      [revId("digestrevB")],
    );
    expect(changed.outcome).toEqual({ outcome: "conflict", reason: "operation_digest" });
  }, 180_000);

  test("a second first-publication for a taken node id is a node_id conflict", async () => {
    const node = nodeId("collidenodeA");
    await publish({ operation_id: "op-collide-1", content: revisionEnvelope(ALPHA, alpha, node) }, [
      revId("colliderevA"),
    ]);
    const second = await publish(
      { operation_id: "op-collide-2", content: revisionEnvelope(ALPHA, alpha, node) },
      [revId("colliderevB")],
    );
    expect(second.outcome).toEqual({ outcome: "conflict", reason: "node_id" });
  }, 180_000);

  test("a nonnull base against an absent node is not_found", async () => {
    const result = await publish(
      {
        operation_id: "op-missing-base",
        content: revisionEnvelope(ALPHA, alpha, nodeId("nosuchnodeA"), {
          base_revision_id: revId("nosuchrevA"),
        }),
      },
      [revId("neverusedA")],
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("not_found");
  }, 180_000);

  test("a stale base against a live node is a stale_base conflict", async () => {
    const node = nodeId("stalenodeA");
    await publish({ operation_id: "op-stale-1", content: revisionEnvelope(ALPHA, alpha, node) }, [
      revId("stalerevA"),
    ]);
    const stale = await publish(
      {
        operation_id: "op-stale-2",
        content: revisionEnvelope(ALPHA, alpha, node, { base_revision_id: revId("wrongbaseA") }),
      },
      [revId("stalerevB")],
    );
    expect(stale.outcome).toEqual({ outcome: "conflict", reason: "stale_base" });
  }, 180_000);
});

describe("successive revisions build real ancestry", () => {
  test("a second revision appends, advances the head and yields ordered history", async () => {
    const node = nodeId("chainnodeA");
    const first = revId("chainrev1A");
    const second = revId("chainrev2A");

    await publish({ operation_id: "op-chain-1", content: revisionEnvelope(ALPHA, alpha, node) }, [first]);
    const appended = await publish(
      {
        operation_id: "op-chain-2",
        content: revisionEnvelope(ALPHA, alpha, node, { base_revision_id: first, title: "second" }),
      },
      [second],
    );
    expect(appended.outcome!.outcome).toBe("accepted");
    expect(appended.outcome!.revision_no).toBe("2");

    const reader = await openPublicationReader(fixture.datasetRoot);
    const history = (await reader.listAcceptedHistory(
      encodeRequest({ workspace_name: ALPHA, node_id: node }),
    )) as { snapshot_head_revision_id: string; revisions: Record<string, unknown>[] };
    expect(history.revisions.map((r) => r.id)).toEqual([first, second]);
    expect(history.revisions.map((r) => r.revision_no)).toEqual(["1", "2"]);
    expect(history.revisions[0]!.base_revision_id).toBeNull();
    expect(history.revisions[1]!.base_revision_id).toBe(first);
    expect(history.snapshot_head_revision_id).toBe(second);
  }, 180_000);
});

describe("scoped references are validated against real seeded rows", () => {
  test("an unknown peer is rejected as an invalid reference", async () => {
    const result = await publish(
      {
        operation_id: "op-badpeer",
        content: revisionEnvelope(ALPHA, alpha, nodeId("badpeernode"), {
          author_peer_name: "no-such-peer",
        }),
      },
      [revId("badpeerrev")],
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_reference");
  }, 180_000);

  test("a peer from ANOTHER workspace is rejected — seeds really are separate", async () => {
    const result = await publish(
      {
        operation_id: "op-crosspeer",
        content: revisionEnvelope(ALPHA, alpha, nodeId("crosspeernode"), {
          author_peer_name: beta.peer_names[0],
        }),
      },
      [revId("crosspeerrev")],
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_reference");
  }, 180_000);

  test("a RETIRED term cannot be newly assigned", async () => {
    const retired = alpha.term_ids.topic.retired_topic;
    const typeTerm = alpha.term_ids.type.note;
    const result = await publish(
      {
        operation_id: "op-retired",
        content: revisionEnvelope(ALPHA, alpha, nodeId("retirednode"), {
          term_snapshot_json: JSON.stringify([
            {
              term_id: typeTerm.id,
              vocabulary_id: typeTerm.vocabulary_id,
              vocabulary_name_snapshot: typeTerm.vocabulary_name,
              term_name_snapshot: typeTerm.name,
              label_snapshot: null,
              position: "0",
            },
            {
              term_id: retired.id,
              vocabulary_id: retired.vocabulary_id,
              vocabulary_name_snapshot: retired.vocabulary_name,
              term_name_snapshot: retired.name,
              label_snapshot: null,
              position: "1",
            },
          ]),
        }),
      },
      [revId("retiredrev")],
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_reference");
  }, 180_000);

  test("an ACTIVE term from a SEALED vocabulary IS assignable", async () => {
    // Sealing governs term CREATION, not assignment. A test asserting blanket
    // rejection here would be pinning the wrong rule.
    const sealed = alpha.term_ids.topic.storage;
    const typeTerm = alpha.term_ids.type.note;
    const result = await publish(
      {
        operation_id: "op-sealed-ok",
        content: revisionEnvelope(ALPHA, alpha, nodeId("sealednode"), {
          term_snapshot_json: JSON.stringify([
            {
              term_id: typeTerm.id,
              vocabulary_id: typeTerm.vocabulary_id,
              vocabulary_name_snapshot: typeTerm.vocabulary_name,
              term_name_snapshot: typeTerm.name,
              label_snapshot: null,
              position: "0",
            },
            {
              term_id: sealed.id,
              vocabulary_id: sealed.vocabulary_id,
              vocabulary_name_snapshot: sealed.vocabulary_name,
              term_name_snapshot: sealed.name,
              label_snapshot: null,
              position: "1",
            },
          ]),
        }),
      },
      [revId("sealedrev")],
    );
    expect(result.ok).toBe(true);
    expect(result.outcome!.outcome).toBe("accepted");
  }, 180_000);

  test("a nonnull label_snapshot is refused for NEW content", async () => {
    const typeTerm = alpha.term_ids.type.note;
    const result = await publish(
      {
        operation_id: "op-label",
        content: revisionEnvelope(ALPHA, alpha, nodeId("labelnode"), {
          term_snapshot_json: JSON.stringify([
            {
              term_id: typeTerm.id,
              vocabulary_id: typeTerm.vocabulary_id,
              vocabulary_name_snapshot: typeTerm.vocabulary_name,
              term_name_snapshot: typeTerm.name,
              label_snapshot: "a label that must not be accepted",
              position: "0",
            },
          ]),
        }),
      },
      [revId("labelrev")],
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_request");
  }, 180_000);

  test("a cross-workspace session reference is rejected", async () => {
    const result = await publish(
      {
        operation_id: "op-crosssession",
        content: revisionEnvelope(ALPHA, alpha, nodeId("crosssessnode"), {
          session_name: beta.session_name,
        }),
      },
      [revId("crosssessrev")],
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_reference");
  }, 180_000);
});

describe("requests are raw bytes and strictly bounded", () => {
  test("getAcceptedHead refuses a non-Uint8Array argument", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    // There is deliberately no plain-object entrypoint: a second parser path
    // would be a second canonicalizer.
    await expect(
      reader.getAcceptedHead({ workspace_name: ALPHA, node_id: nodeId("x") } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("a malformed or over-long scope is refused before any lookup", async () => {
    const reader = await openPublicationReader(fixture.datasetRoot);
    for (const bad of [{ workspace_name: "", node_id: nodeId("a") }, { workspace_name: "a".repeat(300), node_id: nodeId("a") }]) {
      await expect(reader.getAcceptedHead(encodeRequest(bad))).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
  });
});

describe("post-write readback failure poisons the owner", () => {
  /**
   * Contract section 7: ANY ambiguous post-write or readback failure enters
   * fail-stop for that owner, and no further queued mutation may run.
   *
   * The distinction this pins, which a throwing hook does NOT cover: the hook
   * here returns NORMALLY after corrupting the just-written row, so the
   * service meets a genuine readback failure rather than a hook error. A
   * repair that only catches hook throws would still pass D1 and fail this.
   */
  const CORRUPT_CHILD = new URL(
    "./fixtures/publication-v1/corrupt-after-append.ts",
    import.meta.url,
  ).pathname;

  test("a corrupted readback fail-stops the owner and blocks the NEXT operation", async () => {
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const firstRevision = revId("poisonrev1");
      const payload = {
        first: {
          operation_id: "op-poison-1",
          content: revisionEnvelope(ALPHA, seeded, nodeId("poisonnode1")),
        },
        second: {
          operation_id: "op-poison-2",
          content: revisionEnvelope(ALPHA, seeded, nodeId("poisonnode2")),
        },
        revisionIds: [firstRevision, revId("poisonrev2")],
        clockMs: CLOCK_MS,
        corruptRevisionId: firstRevision,
      };
      const result = await runGated(local.datasetRoot, CORRUPT_CHILD, [
        local.datasetRoot,
        JSON.stringify(payload),
      ]);
      const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
      expect(line, `no output (${result.code}): ${result.stderr.slice(0, 400)}`).toBeDefined();
      const parsed = JSON.parse(line!) as {
        first: { ok: boolean; code?: string };
        second: { ok: boolean; code?: string };
        revisionRows: number;
      };

      // The first operation must NOT report success: its readback disagreed
      // with what it wrote.
      expect(parsed.first.ok).toBe(false);
      // `code` is optional on the wire, so narrow it by control flow before the
      // membership check. `toContain` would reject an undefined at runtime
      // anyway; what this buys is a TypeScript narrowing without a cast, and a
      // diagnostic that names the missing/non-string value and prints the line
      // instead of reporting only that the array did not contain it.
      const firstCode = parsed.first.code;
      if (typeof firstCode !== "string") {
        throw new Error(`first.code must be a string, got ${JSON.stringify(firstCode)}: ${line}`);
      }
      expect(["recovery_required", "integrity_failure"]).toContain(firstCode);

      // The owner is now ambiguous, so the SECOND operation must be refused
      // rather than quietly writing on top of unexplained state.
      expect(parsed.second.ok).toBe(false);
      expect(parsed.second.code).toBe("recovery_required");

      // And it really did not write: only the first (corrupted) row exists.
      expect(parsed.revisionRows).toBe(1);
    } finally {
      await local.cleanup();
    }
  }, 300_000);
});

async function publishInto(
  datasetRoot: string,
  request: unknown,
  revisionIds: string[],
): Promise<{ ok: boolean; outcome?: Record<string, unknown>; code?: string | null }> {
  const result = await runGated(datasetRoot, CHILD, [
    datasetRoot,
    JSON.stringify({ request, revisionIds, clockMs: CLOCK_MS }),
  ]);
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (line === undefined) throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 400)}`);
  return JSON.parse(line);
}

describe("a failure at the HEAD write also fail-stops the owner", () => {
  /**
   * The revision row is durable before the node/head write happens, so an
   * SDK rejection there is squarely inside the ambiguous window. This is a
   * different site from the readback case: an earlier repair covered the
   * revision readback while leaving the node append and head update
   * unguarded, so only a per-operation boundary catches both.
   *
   * The hook returns NORMALLY again -- the failure comes from real durable
   * state, not from the hook throwing.
   */
  const CORRUPT_CHILD = new URL(
    "./fixtures/publication-v1/corrupt-after-append.ts",
    import.meta.url,
  ).pathname;

  test("a rejected head write blocks the next operation and writes nothing more", async () => {
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const target = nodeId("headfailnode");
      // The node must already EXIST with a head, so the failing write is the
      // guarded conditional head UPDATE rather than a first-node append.
      const seedFirst = await publishInto(local.datasetRoot, {
        operation_id: "op-head-0",
        content: revisionEnvelope(ALPHA, seeded, target),
      }, [revId("headfailrev0")]);
      expect(seedFirst.outcome!.outcome).toBe("accepted");

      const payload = {
        first: {
          operation_id: "op-head-1",
          content: revisionEnvelope(ALPHA, seeded, target, {
            base_revision_id: revId("headfailrev0"),
            title: "second revision",
          }),
        },
        second: {
          operation_id: "op-head-2",
          content: revisionEnvelope(ALPHA, seeded, nodeId("headfailnode2")),
        },
        revisionIds: [revId("headfailrev1"), revId("headfailrev2")],
        clockMs: CLOCK_MS,
        corruptRevisionId: revId("headfailrev1"),
        claimNodeId: target,
        mode: "head" as const,
      };
      const result = await runGated(local.datasetRoot, CORRUPT_CHILD, [
        local.datasetRoot,
        JSON.stringify(payload),
      ]);
      const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
      expect(line, `no output (${result.code}): ${result.stderr.slice(0, 400)}`).toBeDefined();
      const parsed = JSON.parse(line!) as {
        first: { ok: boolean; code?: string };
        second: { ok: boolean; code?: string };
        revisionRows: number;
      };

      expect(parsed.first.ok).toBe(false);
      // The second operation must be refused: the owner is ambiguous.
      expect(parsed.second.ok).toBe(false);
      expect(parsed.second.code).toBe("recovery_required");
      // The seeded revision plus the durable-but-unheaded one; the refused
      // second operation added nothing.
      expect(parsed.revisionRows).toBe(2);
    } finally {
      await local.cleanup();
    }
  }, 300_000);
});

describe("internal link targets use the codec's canonical key names", () => {
  /**
   * The keys are fixed by the protected evidence codec's TARGET_KEYS:
   * message is (session_name, message_public_id), session is (session_name),
   * trace is (trace_id). Earlier this code read `public_id`, `name` and `id`,
   * spellings that appear nowhere in the codec and so matched nothing.
   */
  const linkSnapshot = (entries: Record<string, unknown>[]) => JSON.stringify(entries);

  const withLinks = (
    seeded: SeededWorkspace,
    node: string,
    links: Record<string, unknown>[],
    overrides: Record<string, unknown> = {},
  ) => revisionEnvelope(ALPHA, seeded, node, { link_snapshot_json: linkSnapshot(links), ...overrides });

  test("a message link resolves by session_name + message_public_id", async () => {
    const result = await publish(
      {
        operation_id: "op-link-message",
        content: withLinks(alpha, nodeId("linkmsgnode"), [
          {
            position: "0",
            relation: "discusses",
            target_kind: "message",
            target: { session_name: alpha.session_name, message_public_id: alpha.message_public_id },
            excerpt: null,
            content_hash: null,
            captured_at: null,
            capture_status: "locator_only",
            note: null,
          },
        ]),
      },
      [revId("linkmsgrev")],
    );
    expect(result.ok).toBe(true);
    expect(result.outcome!.outcome).toBe("accepted");
  }, 180_000);

  test("a trace link resolves by trace_id, and a session link by session_name", async () => {
    const result = await publish(
      {
        operation_id: "op-link-trace",
        content: withLinks(alpha, nodeId("linktracenode"), [
          {
            position: "0",
            relation: "related_to",
            target_kind: "trace",
            target: { trace_id: alpha.trace_id },
            excerpt: null,
            content_hash: null,
            captured_at: null,
            capture_status: "locator_only",
            note: null,
          },
          {
            position: "1",
            relation: "related_to",
            target_kind: "session",
            target: { session_name: alpha.session_name },
            excerpt: null,
            content_hash: null,
            captured_at: null,
            capture_status: "locator_only",
            note: null,
          },
        ]),
      },
      [revId("linktracerev")],
    );
    expect(result.ok).toBe(true);
    expect(result.outcome!.outcome).toBe("accepted");
  }, 180_000);

  test("a SAME-NODE link to an earlier ACCEPTED revision is allowed", async () => {
    // There is no blanket self-node ban in the contract: ancestry membership
    // already excludes the revision being created, because it is not
    // accepted yet. Rejecting all same-node links was an invented rule.
    const node = nodeId("selflinknode");
    const first = revId("selflinkrev1");
    const initial = await publish(
      { operation_id: "op-selflink-1", content: revisionEnvelope(ALPHA, alpha, node) },
      [first],
    );
    // The link below is only meaningful if this revision really was accepted,
    // so prove that before relying on it rather than assuming it.
    expect(initial.ok).toBe(true);
    expect(initial.outcome!.outcome).toBe("accepted");
    expect(initial.outcome!.revision_id).toBe(first);

    const second = await publish(
      {
        operation_id: "op-selflink-2",
        content: withLinks(alpha, node, [
          {
            position: "0",
            relation: "derived_from",
            target_kind: "node_revision",
            target: { node_id: node, revision_id: first },
            excerpt: null,
            content_hash: null,
            captured_at: null,
            capture_status: "locator_only",
            note: null,
          },
        ], { base_revision_id: first }),
      },
      [revId("selflinkrev2")],
    );
    expect(second.ok).toBe(true);
    expect(second.outcome!.outcome).toBe("accepted");
  }, 300_000);
});

describe("a bounded storage failure around the head step fail-stops the owner", () => {
  /**
   * Contract section 7, on paths the existing readback tests do not reach.
   *
   * `corrupt-after-append.ts` provokes a readback DISAGREEMENT, which every
   * inner `afterWrite` wrapper already catches. That is why deleting the
   * operation-wide attempted-write boundary left those tests green: they never
   * depended on it.
   *
   * These cases make the `nodes` table fail at the storage layer instead, once
   * the revision row is already durable. Two distinct failure sites, because
   * they are guarded differently:
   *
   *   - the post-append node RE-CHECK (a read) runs after durability and has
   *     no wrapper of its own, so only the operation-wide boundary covers it;
   *   - the node APPEND itself is individually wrapped.
   *
   * Both must fail-stop, and the first is what kills the operation-wide
   * mutation. The fault child repairs the table before the SECOND operation
   * runs, so a refusal there is the owner's own state and not a filesystem
   * still broken underneath it.
   */
  const SDK_CHILD = new URL(
    "./fixtures/publication-v1/sdk-write-failure.ts",
    import.meta.url,
  ).pathname;

  type ChildResult = {
    seed?: { ok: boolean; outcome?: Record<string, unknown> };
    beforeResume?: { revisionRows: number; nodeRows: number };
    first: { ok: boolean; code?: string | null; message?: string };
    second: { ok: boolean; code?: string | null };
    revisionRows: number;
    nodeRows: number;
  };

  const runFault = async (
    root: string,
    payload: Record<string, unknown>,
  ): Promise<ChildResult> => {
    const result = await runGated(root, SDK_CHILD, [root, JSON.stringify(payload)]);
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) {
      throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 600)}`);
    }
    return JSON.parse(line) as ChildResult;
  };

  test("an unreadable nodes table at the post-durability RE-CHECK fail-stops", async () => {
    // The re-check is a READ, and it is the step with no wrapper of its own.
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const parsed = await runFault(local.datasetRoot, {
        scenario: "fresh_read",
        first: {
          operation_id: "op-sdk-read-1",
          content: revisionEnvelope(ALPHA, seeded, nodeId("sdkreadnode")),
        },
        second: {
          operation_id: "op-sdk-read-2",
          content: revisionEnvelope(ALPHA, seeded, nodeId("sdkreadnode2")),
        },
        revisionIds: [revId("sdkreadrev1"), revId("sdkreadrev2")],
        clockMs: CLOCK_MS,
      });

      // The revision is durable but no node was created, so no success.
      expect(parsed.first.ok).toBe(false);
      // It must be CLASSIFIED, not leak the raw storage rejection.
      expect(parsed.first.code).toBe("recovery_required");

      expect(parsed.second.ok).toBe(false);
      expect(parsed.second.code).toBe("recovery_required");

      // The refusal is real: the second operation added nothing, and no head
      // was invented for a revision that never got one.
      expect(parsed.revisionRows).toBe(1);
      expect(parsed.nodeRows).toBe(0);
    } finally {
      await local.cleanup();
    }
  }, 300_000);

  test("a rejected node APPEND on a readable-but-unwritable table fail-stops", async () => {
    // Discriminates from the case above: reads still succeed, so the service
    // gets past its re-check and the rejection is a real node/head WRITE.
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const parsed = await runFault(local.datasetRoot, {
        scenario: "fresh_write",
        first: {
          operation_id: "op-sdk-write-1",
          content: revisionEnvelope(ALPHA, seeded, nodeId("sdkwritenode")),
        },
        second: {
          operation_id: "op-sdk-write-2",
          content: revisionEnvelope(ALPHA, seeded, nodeId("sdkwritenode2")),
        },
        revisionIds: [revId("sdkwriterev1"), revId("sdkwriterev2")],
        clockMs: CLOCK_MS,
      });

      expect(parsed.first.ok).toBe(false);
      expect(parsed.first.code).toBe("recovery_required");
      expect(parsed.second.ok).toBe(false);
      expect(parsed.second.code).toBe("recovery_required");
      expect(parsed.revisionRows).toBe(1);
      expect(parsed.nodeRows).toBe(0);
    } finally {
      await local.cleanup();
    }
  }, 300_000);

  test("an orphan RESUME whose head append is rejected fail-stops", async () => {
    // Orphan resumption gets its own discriminating coverage rather than
    // inheriting the claim from a fresh publication: it reaches the head
    // append by a different route, reusing a stored revision id and ordinal.
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const node = nodeId("sdkorphnode");
      const parsed = await runFault(local.datasetRoot, {
        scenario: "orphan",
        orphanNodeId: node,
        first: {
          operation_id: "op-sdk-orphan",
          content: revisionEnvelope(ALPHA, seeded, node),
        },
        second: {
          operation_id: "op-sdk-orphan-next",
          content: revisionEnvelope(ALPHA, seeded, nodeId("sdkorphnode2")),
        },
        revisionIds: [revId("sdkorphrev1"), revId("sdkorphrev2")],
        clockMs: CLOCK_MS,
      });

      // Durable BEFORE evidence: the seed published, then its node row was
      // removed, leaving exactly one revision and no node -- a real orphan.
      expect(parsed.seed!.ok).toBe(true);
      expect(parsed.beforeResume).toEqual({ revisionRows: 1, nodeRows: 0 });

      // The resume could not head the node, so it must not claim success.
      expect(parsed.first.ok).toBe(false);
      expect(parsed.first.code).toBe("recovery_required");

      expect(parsed.second.ok).toBe(false);
      expect(parsed.second.code).toBe("recovery_required");

      // Durable AFTER evidence: unchanged. No head was invented for the
      // orphan, and the refused second operation wrote nothing.
      expect(parsed.revisionRows).toBe(1);
      expect(parsed.nodeRows).toBe(0);
    } finally {
      await local.cleanup();
    }
  }, 300_000);

  test("a pre-write validation error leaves the owner USABLE", async () => {
    // The positive control. Fail-stop must be scoped to the ambiguous window;
    // if it also fired for rejections that wrote nothing, every one of the
    // assertions above would pass for entirely the wrong reason.
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const parsed = await runFault(local.datasetRoot, {
        scenario: "control",
        first: {
          operation_id: "op-sdk-control-bad",
          // Rejected during validation, before anything is written.
          content: revisionEnvelope(ALPHA, seeded, nodeId("ctlnode"), { title: null }),
        },
        second: {
          operation_id: "op-sdk-control-good",
          content: revisionEnvelope(ALPHA, seeded, nodeId("ctlnode2")),
        },
        revisionIds: [revId("sdkctlrev1"), revId("sdkctlrev2")],
        clockMs: CLOCK_MS,
      });

      expect(parsed.first.ok).toBe(false);
      expect(parsed.first.code).not.toBe("recovery_required");
      // The owner was never poisoned, so the next operation is accepted.
      expect(parsed.second.ok).toBe(true);
      expect(parsed.revisionRows).toBe(1);
      expect(parsed.nodeRows).toBe(1);
    } finally {
      await local.cleanup();
    }
  }, 300_000);
});

describe("closing the writer releases the inherited gate EXACTLY once", () => {
  /**
   * A descriptor number is a reusable integer, not an identity.
   *
   * `close()` releases the inherited gate descriptor. Once fd 42 is closed the
   * kernel may hand 42 back for something else, so a `close()` that releases on
   * every call will eventually close a descriptor it never owned. That matters
   * now because a shared owner bundle needs one-shot release.
   *
   * The child below proves it without mocking anything: it closes the writer,
   * takes fd 42 back for a harmless temporary file of its own, closes again,
   * and asks whether that unrelated descriptor survived.
   */
  const CLOSE_CHILD = new URL(
    "./fixtures/publication-v1/close-once.ts",
    import.meta.url,
  ).pathname;

  type CloseResult = {
    gateFd: number;
    published?: { ok: boolean; outcome?: Record<string, unknown> };
    firstCloseReturned?: boolean;
    secondCloseReturned?: boolean;
    seizedGateFd?: boolean;
    unrelatedFdStillOpen?: boolean | null;
    unrelatedFdIsOurFile?: boolean;
    unrelatedFdCloseError?: string | null;
    closeIdentity?: boolean;
    settledWhileParked?: boolean;
    closeStatuses?: string[];
    queuedAfterClose?: { ok: boolean; code?: string | null };
    readAfterClose?: { ok: boolean; code?: string | null };
    gateFdStillOpen?: boolean;
  };

  const runClose = async (root: string, payload: Record<string, unknown>): Promise<CloseResult> => {
    const result = await runGated(root, CLOSE_CHILD, [root, JSON.stringify(payload)]);
    // A child that died or was reaped can still have printed a partial line.
    // Its JSON is only evidence if it exited cleanly.
    if (result.code !== 0) {
      throw new Error(`child exited ${result.code}: ${result.stderr.slice(0, 600)}`);
    }
    const line = result.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (line === undefined) {
      throw new Error(`no output (${result.code}): ${result.stderr.slice(0, 600)}`);
    }
    return JSON.parse(line) as CloseResult;
  };

  test("a second close does NOT close an unrelated descriptor at the same number", async () => {
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const parsed = await runClose(local.datasetRoot, {
        scenario: "reuse",
        request: {
          operation_id: "op-close-once",
          content: revisionEnvelope(ALPHA, seeded, nodeId("closeoncenode")),
        },
        revisionIds: [revId("closeoncerev1")],
        clockMs: CLOCK_MS,
      });

      // The setup has to have actually happened, or the assertion below would
      // pass for the wrong reason.
      expect(parsed.published!.ok).toBe(true);
      expect(parsed.firstCloseReturned).toBe(true);
      // Without the seizure the scenario says nothing, so it fails HERE rather
      // than on a descriptor nobody proved we owned.
      expect(parsed.seizedGateFd, "child never reclaimed the gate fd number").toBe(true);
      expect(parsed.secondCloseReturned).toBe(true);

      // THE defect: before the repair the second close closes fd 42 again,
      // and fd 42 is now the child's own temporary file.
      expect(parsed.unrelatedFdStillOpen).toBe(true);
      // And it is genuinely OUR file, matched by device and inode, not merely
      // some descriptor that happens to be open at that number.
      expect(parsed.unrelatedFdIsOurFile).toBe(true);
    } finally {
      await local.cleanup();
    }
  }, 300_000);

  test("repeated concurrent close drains once and preserves surrounding behaviour", async () => {
    const local = await createFixture([ALPHA]);
    try {
      const seeded = local.workspaces[ALPHA]!;
      const parsed = await runClose(local.datasetRoot, {
        scenario: "concurrent",
        request: {
          operation_id: "op-close-conc-1",
          content: revisionEnvelope(ALPHA, seeded, nodeId("closeconcnode")),
        },
        queued: {
          operation_id: "op-close-conc-2",
          content: revisionEnvelope(ALPHA, seeded, nodeId("closeconcnode2")),
        },
        revisionIds: [revId("closeconcrev1"), revId("closeconcrev2")],
        clockMs: CLOCK_MS,
      });

      // ONE promise handed back, not three equivalent ones.
      expect(parsed.closeIdentity).toBe(true);
      // While the in-flight operation is parked on its boundary, no close may
      // report completion: close drains, it does not abandon.
      expect(parsed.settledWhileParked).toBe(false);
      // All three settle once the park is released.
      expect(parsed.closeStatuses).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      // The parked operation finished and was accepted.
      expect(parsed.published!.ok).toBe(true);
      expect(parsed.published!.outcome!.outcome).toBe("accepted");
      // Queued after close is still refused, exactly as before.
      expect(parsed.queuedAfterClose!.ok).toBe(false);
      expect(parsed.queuedAfterClose!.code).toBe("recovery_required");
      // Reads after close are still refused by the released adapter, with the
      // exact contract code rather than merely "some error".
      expect(parsed.readAfterClose!.ok).toBe(false);
      expect(parsed.readAfterClose!.code).toBe("recovery_required");
      // And the gate really was released.
      expect(parsed.gateFdStillOpen).toBe(false);
    } finally {
      await local.cleanup();
    }
  }, 300_000);
});
