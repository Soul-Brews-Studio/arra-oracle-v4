/**
 * #32 slice A (overnight ruling R9, docs/overnight/DECISIONS.md): `answerChat`
 * must not need a writer, so chat and writes coexist in one gated process.
 *
 * THE DEFECT (analysis-32, measured): `answerChat` lived on the writer facade
 * only because the injected model travelled in writer options. The transport
 * therefore opened an "ephemeral" writer per chat call. In ONE gated server
 * process that fails both ways round:
 *
 *   - write first: the cached writer holds the one-per-process `OWNERS` slot,
 *     so every later `answerChat` answered 503 `writer_unavailable`;
 *   - chat first: closing the ephemeral writer released the process's only
 *     inherited fd-42 gate, so every later write answered 503
 *     `writer_unavailable` until restart.
 *
 * Proven here with nothing faked but the model: a fresh mkdtemp dataset, the
 * REAL fd-42 gate (`runGated` -> `exec_with_gate`, the dev server's own
 * launcher), the production composition (`composeKnowledgeAccess` over env),
 * a real arra-auth/v1 policy file, and the real HTTP and MCP transports. The
 * model is a recording stub on 127.0.0.1 in THIS process, reached by the child
 * through `ARRA_CHAT_PROVIDER=ollama` + `ARRA_CHAT_URL`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startChatModelStub, type ChatModelStub } from "./helpers/chat-model-stub";
import { createContextFixture } from "./helpers/context-fixture";
import { runGated } from "./helpers/publication-fixture";

const CHILD = new URL("./fixtures/chat-v1/gate-coexistence-child.ts", import.meta.url).pathname;
const TIMEOUT_MS = 240_000;
const WS = "alpha-workspace";
const TOKEN = createHash("sha256").update("chat-gate-coexistence").digest("hex");
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

type Step = { label: string; status: number; ok: boolean; code: string | null; answer?: string; items_used?: string[] };
type Run = { phase: string; steps: Step[] };

let cleanup: (() => Promise<void>) | null = null;
let policyDir: string | null = null;
let stub: ChatModelStub;
let writeFirst: Run;
let askFirst: Run;
let writeFirstModelCalls = 0;
let askFirstModelCalls = 0;

async function runPhase(datasetRoot: string, policyPath: string, phase: string): Promise<Run> {
  const run = await runGated(datasetRoot, CHILD, [policyPath, phase], {
    deadlineMs: 90_000,
    env: {
      ARRA_KNOWLEDGE_DATASET_ROOT: datasetRoot,
      ARRA_CHAT_PROVIDER: "ollama",
      ARRA_CHAT_URL: stub.url,
      COEXIST_TOKEN: TOKEN,
    },
  });
  const line = run.stdout.trim().split("\n").pop();
  if (run.code !== 0 || line === undefined || line === "") {
    throw new Error(`gated child ${phase} failed (${run.code}): ${run.stderr.slice(-1500)}`);
  }
  return JSON.parse(line) as Run;
}

const step = (run: Run, label: string): Step => {
  const found = run.steps.find((s) => s.label === label);
  if (found === undefined) throw new Error(`no step ${label} in ${JSON.stringify(run.steps)}`);
  return found;
};

beforeAll(async () => {
  stub = startChatModelStub("ok");
  const fixture = await createContextFixture([WS]);
  cleanup = fixture.cleanup;
  policyDir = await mkdtemp(join(tmpdir(), "arra-v4-chat-coexist-"));
  const policyPath = join(policyDir, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        { id: "op", disabled: false, workspaces: [{ name: WS, actions: ["content:read", "content:write"] }], global_actions: [] },
      ],
      credentials: [
        {
          id: "cred-op",
          principal_id: "op",
          sha256: createHash("sha256").update(TOKEN, "ascii").digest("hex"),
          not_before: "2026-01-01T00:00:00.000Z",
          expires_at: "2030-01-01T00:00:00.000Z",
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  writeFirst = await runPhase(fixture.datasetRoot, policyPath, "write-first");
  writeFirstModelCalls = stub.requests.length;
  askFirst = await runPhase(fixture.datasetRoot, policyPath, "ask-first");
  askFirstModelCalls = stub.requests.length - writeFirstModelCalls;
}, TIMEOUT_MS);

afterAll(async () => {
  stub?.stop();
  if (policyDir !== null) await rm(policyDir, { recursive: true, force: true });
  if (cleanup !== null) await cleanup();
});

describe("write first, then chat, in one gated process", () => {
  test("the seeding writes succeed on the cached writer", () => {
    for (const label of ["write:registerPeer", "write:registerSession", "write:joinSession", "write:append1"]) {
      expect(step(writeFirst, label), label).toMatchObject({ status: 200, ok: true });
    }
  });

  test("three answers while the cached writer is held: each is a real model answer citing the evidence", () => {
    for (const label of ["ask:1", "ask:2", "ask:3"]) {
      const s = step(writeFirst, label);
      expect(s, JSON.stringify(s)).toMatchObject({ status: 200, ok: true, code: null });
      expect(s.items_used).toEqual([pad("coexist1")]);
      expect(s.answer).toContain(`[${pad("coexist1")}]`);
    }
    expect(writeFirstModelCalls).toBe(3);
  });

  test("a write after three answers still succeeds", () => {
    expect(step(writeFirst, "write:append2")).toMatchObject({ status: 200, ok: true });
  });
});

describe("chat first, then writes, in a FRESH gated process", () => {
  test("the process's very first call is an answer", () => {
    const s = step(askFirst, "ask:first");
    expect(s, JSON.stringify(s)).toMatchObject({ status: 200, ok: true, code: null });
  });

  test("a write after that first answer succeeds: the inherited gate was never released", () => {
    expect(step(askFirst, "write:after-ask")).toMatchObject({ status: 200, ok: true, code: null });
  });

  test("three more answers, then another write, all succeed", () => {
    for (const label of ["ask:a", "ask:b", "ask:c", "write:after-three"]) {
      const s = step(askFirst, label);
      expect(s, `${label} ${JSON.stringify(s)}`).toMatchObject({ status: 200, ok: true, code: null });
    }
  });

  test("the same order over MCP on the same process: answer, then write", () => {
    expect(step(askFirst, "mcp:ask")).toMatchObject({ ok: true, code: null });
    expect(step(askFirst, "mcp:write")).toMatchObject({ ok: true, code: null });
  });

  test("exactly one model call per answer: 4 over HTTP + 1 over MCP", () => {
    expect(askFirstModelCalls).toBe(5);
    for (const request of stub.requests) expect(request.path).toBe("/api/chat");
  });
});
