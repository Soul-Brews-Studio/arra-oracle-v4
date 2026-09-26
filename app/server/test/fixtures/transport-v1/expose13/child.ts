// #31 overnight R7/R8 (#28, #29, #30, #31): real-dataset, real-gate child for
// `knowledge-expose13-live.test.ts`.
//
// Runs INSIDE the real writer gate (`arra_migrate.writer_gate.exec_with_gate`,
// fd 42), boots the REAL HTTP app (`src/app.ts` + `src/knowledge/transport.ts`'s
// `createKnowledgeAccess`) AND the REAL MCP adapter
// (`auth/service.ts`'s `createOperationService` + `mcp/index.ts`'s
// `createMcpAdapter`) against the SAME `KnowledgeAccess`, exactly the way
// `composition.ts` wires one process for both transports in production. It
// then replays a caller-supplied list of steps at the wire — no facade is
// called directly — and prints one JSON array of outcomes, one per step, so
// the parent test owns every assertion.
//
// Every id used across steps is CALLER-CHOSEN (nanoid21 the caller mints)
// EXCEPT a revision id, which the writer assigns (`randomNanoid21` in
// `writerOptions()`, `knowledge/transport.ts`) — the caller has no way to
// pre-name one. A step may `capture` a value out of its own response (e.g.
// `publishRevision`'s `revision_id`, or an indexed chunk's `id`) under a
// name; any later step's `body` may reference that name as the exact string
// `"@name"`, substituted just before that step runs. Everything else in the
// step list is static, computed once in the parent.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../../../src/app";
import { createKnowledgeAccess } from "../../../../src/knowledge/transport";
import { createOperationService, type OperationService, type StoreDependencies } from "../../../../src/auth/service";
import { createMcpAdapter, configureKnowledgeAccess } from "../../../../src/mcp";
import { readArgPayload } from "../../../helpers/argv.readArgPayload";

const [, , root, workDir, payloadJson] = process.argv;
const payload = JSON.parse(readArgPayload(payloadJson) ?? "{}") as {
  banks: { alpha: string; beta: string };
  steps: Array<{
    label: string;
    transport: "http" | "mcp";
    token: "write" | "read" | "other";
    bank: "alpha" | "beta";
    method: string;
    body: unknown;
    /** Path INTO this step's own outcome (after the http `.body` / mcp
     *  `.value` root) to stash under `name`, for a later step's `"@name"`. */
    capture?: { name: string; path: (string | number)[] };
  }>;
};

/** name -> captured value, filled in as steps with a `capture` clause run. */
const captured: Record<string, unknown> = {};

/** Deep-replace any string exactly equal to `"@name"` with `captured[name]`.
 *  Only exact-match whole-string tokens substitute -- never a substring --
 *  so an ordinary string that happens to start with `@` is never mistaken
 *  for a placeholder. */
function substitute(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("@") && value.slice(1) in captured) {
    return captured[value.slice(1)];
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
}

function readPath(obj: unknown, path: (string | number)[]): unknown {
  let node = obj;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

const ORIGIN = "http://127.0.0.1:3939";
const sha = (v: string) => createHash("sha256").update(v, "ascii").digest("hex");

const WRITE_TOKEN = "1".repeat(64);
const READ_TOKEN = "2".repeat(64);
const OTHER_TOKEN = "3".repeat(64);
const TOKEN_OF = { write: WRITE_TOKEN, read: READ_TOKEN, other: OTHER_TOKEN } as const;

const NOT_BEFORE = "2020-01-01T00:00:00.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

function writePolicy(): string {
  const policyPath = join(workDir!, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        {
          id: "alpha-write",
          disabled: false,
          workspaces: [{ name: payload.banks.alpha, actions: ["content:read", "content:write"] }],
          global_actions: [],
        },
        {
          id: "alpha-read",
          disabled: false,
          workspaces: [{ name: payload.banks.alpha, actions: ["content:read"] }],
          global_actions: [],
        },
        {
          id: "beta-write",
          disabled: false,
          workspaces: [{ name: payload.banks.beta, actions: ["content:read", "content:write"] }],
          global_actions: [],
        },
      ],
      credentials: [
        {
          id: "cred-write",
          principal_id: "alpha-write",
          sha256: sha(WRITE_TOKEN),
          not_before: NOT_BEFORE,
          expires_at: EXPIRES_AT,
          revoked: false,
        },
        {
          id: "cred-read",
          principal_id: "alpha-read",
          sha256: sha(READ_TOKEN),
          not_before: NOT_BEFORE,
          expires_at: EXPIRES_AT,
          revoked: false,
        },
        {
          id: "cred-other",
          principal_id: "beta-write",
          sha256: sha(OTHER_TOKEN),
          not_before: NOT_BEFORE,
          expires_at: EXPIRES_AT,
          revoked: false,
        },
      ],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
  return policyPath;
}

const policyPath = writePolicy();
// The ONE real, writer-gated KnowledgeAccess -- shared by HTTP and MCP below,
// the same way `composeKnowledgeAccess` hands one instance to both
// `createApp` and `configureKnowledgeAccess` in `composition.ts`.
const access = createKnowledgeAccess({ datasetRoot: root, env: process.env });

const httpService = {} as unknown as OperationService; // unused: no /api/memories route exercised
const unusedMcpHandle = (() => {
  throw new Error("unused: /mcp/:bank is not exercised, the MCP adapter is called directly");
}) as unknown as ReturnType<typeof createMcpAdapter>;
const app = createApp({ origin: ORIGIN }, httpService, unusedMcpHandle, { knowledge: { policyPath, access } });

const deps = { logCall: async () => {} } as unknown as StoreDependencies;
const mcpService = createOperationService({ policyPath }, deps);
configureKnowledgeAccess(access);
const mcpAdapter = createMcpAdapter(mcpService);

async function runHttp(bank: string, token: string, method: string, body: unknown) {
  const res = await app.handle(
    new Request(`${ORIGIN}/api/knowledge/${bank}/${method}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3939", authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const responseBody = await res.json().catch(() => null);
  return { status: res.status, body: responseBody };
}

async function runMcp(bank: string, token: string, method: string, body: unknown) {
  const outcome = await mcpAdapter(bank, `Bearer ${token}`, async () => ({
    method: "tools/call",
    id: 1,
    params: { name: `kb_${method}`, arguments: { payload: body } },
  }));
  if (outcome.kind === "denied") return { denied: outcome.code };
  const parsed = (await outcome.response.json()) as {
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
  };
  const result = parsed.result;
  if (result === undefined) return { malformed: parsed };
  if (result.isError === true) return { isError: true, message: result.content?.[0]?.text ?? null };
  const text = result.content?.[0]?.text ?? "null";
  return { ok: true, value: JSON.parse(text) };
}

const outcomes: Record<string, unknown> = {};
for (const step of payload.steps) {
  const bank = step.bank === "alpha" ? payload.banks.alpha : payload.banks.beta;
  const token = TOKEN_OF[step.token];
  const body = substitute(step.body);
  let outcome: unknown;
  try {
    outcome =
      step.transport === "http"
        ? await runHttp(bank, token, step.method, body)
        : await runMcp(bank, token, step.method, body);
  } catch (error) {
    outcome = { threw: error instanceof Error ? error.message : String(error) };
  }
  outcomes[step.label] = outcome;
  if (step.capture !== undefined) {
    // The `.body` (http) / `.value` (mcp, non-error) root, then the step's
    // own path into it -- e.g. `["revision_id"]` or `["rows", 0, "id"]`.
    const valueRoot =
      step.transport === "http" ? (outcome as { body?: unknown }).body : (outcome as { value?: unknown }).value;
    captured[step.capture.name] = readPath(valueRoot, step.capture.path);
  }
}

console.log(JSON.stringify(outcomes));
