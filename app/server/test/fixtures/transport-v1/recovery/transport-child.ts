// #31 transport recovery child — one gated program, selected by mode.
//
// Runs inside a process that genuinely holds the writer gate (via
// `runGated`/`arra_migrate.writer_gate.exec_with_gate`), boots the REAL HTTP
// app from `src/app.createApp.ts` wired to the REAL `createKnowledgeAccess` from
// `src/knowledge/transport.ts` -- the exact production factory, not a
// reimplementation -- and drives it with real `Request`/`app.handle()` calls.
// No facade is called directly: every property below is observed at the wire.
//
// Prints one `EVENT <name> <json>` line per step; the parent
// (`transport-recovery.test.ts`) owns every expectation.

import { chmodSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createApp } from "../../../../src/app.createApp";
import { createKnowledgeAccess } from "../../../../src/knowledge/transport";
import type { OperationService } from "../../../../src/auth/service.createOperationService";
import type { createMcpAdapter } from "../../../../src/mcp";

const [, , mode, root, workDir] = process.argv as [string, string, string, string, string];

const say = (name: string, value: unknown) => console.log(`EVENT ${name} ${JSON.stringify(value)}`);

/** Pad/truncate to EXACTLY 21 chars of the nanoid21 alphabet -- never shorter. */
const id21 = (slug: string): string => `${slug}${"_".repeat(Math.max(0, 21 - slug.length))}`.slice(0, 21);

const ORIGIN = "http://127.0.0.1:3939";
const WORKSPACE = "alpha-workspace";
const TOKEN = "f".repeat(64); // matches BEARER_PATTERN: 64 lowercase hex
const TOKEN_SHA256 = createHash("sha256").update(TOKEN, "ascii").digest("hex");
const NOT_BEFORE = "2020-01-01T00:00:00.000Z";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

function writePolicy(): string {
  const policyPath = join(workDir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [
        {
          id: "op",
          disabled: false,
          workspaces: [{ name: WORKSPACE, actions: ["content:read", "content:write"] }],
          global_actions: [],
        },
      ],
      credentials: [
        {
          id: "cred",
          principal_id: "op",
          sha256: TOKEN_SHA256,
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

async function buildApp() {
  const policyPath = writePolicy();
  const access = createKnowledgeAccess({ datasetRoot: root, env: process.env });
  const service = {} as unknown as OperationService; // unused: no /api/memories route exercised
  const mcpHandle = (() => {
    throw new Error("unused in this fixture");
  }) as unknown as ReturnType<typeof createMcpAdapter>;
  const app = createApp({ origin: ORIGIN }, service, mcpHandle, { knowledge: { policyPath, access } });
  return app;
}

const post = (app: { handle: (r: Request) => Promise<Response> }, method: string, body: unknown) =>
  app.handle(
    new Request(`${ORIGIN}/api/knowledge/${WORKSPACE}/${method}`, {
      method: "POST",
      headers: { host: "127.0.0.1:3939", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

/** Table directories are `<table>.lance` directly under the dataset root. */
const tablePath = (table: string) => join(root, `${table}.lance`);

/** Recursively lock a whole table tree: chmod on the top directory alone does
 *  NOT block new files under its own writable subdirectories (LanceDB keeps
 *  fragment data and manifests in `data/`, `_transactions/`, `_versions/`),
 *  so children are locked before the parent. */
function lockTree(dir: string, mode: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) lockTree(join(dir, entry.name), mode);
  }
  chmodSync(dir, mode);
}

/** Parent first, then descend: a 0o000 tree cannot be listed before it is opened. */
function unlockTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlockTree(join(dir, entry.name));
  }
}

async function outcome(res: Response): Promise<{ status: number; body: unknown }> {
  return { status: res.status, body: await res.json().catch(() => null) };
}

if (mode === "poison") {
  const app = await buildApp();

  // 1. A plain write succeeds, on a real dataset, through the real transport.
  const first = await post(app, "registerPeer", { workspace_name: WORKSPACE, peer_id: id21("peer-first"), name: "peer-first" });
  say("write:first", await outcome(first));

  // 2. Lock the PEERS table so the SDK append genuinely fails inside the write
  //    (`writer.append` throws in `writeRow`, service.ts ~2900) -- a real SDK
  //    failure, not a commanded test hook.
  lockTree(tablePath("peers"), 0o500);

  // 3. The write that hits the locked table poisons the shared owner.
  const second = await post(app, "registerPeer", { workspace_name: WORKSPACE, peer_id: id21("peer-second"), name: "peer-second" });
  say("write:second-locked-table", await outcome(second));

  // 4. A DIFFERENT facade (sessions, not peers) on the SAME owner: poison is
  //    shared across the whole writer core, not scoped to the table that failed.
  const third = await post(app, "registerSession", { workspace_name: WORKSPACE, session_id: id21("sess-third"), name: "session-third" });
  say("write:third-different-facade", await outcome(third));

  // 5. A read on the SAME owner still answers -- reads bypass the write queue.
  const read = await post(app, "getPeer", { workspace_name: WORKSPACE, peer_name: "peer-first" });
  say("read:after-poison", await outcome(read));

  // cleanup so the parent's temp-dir removal does not trip over a locked table
  unlockTree(tablePath("peers"));
  say("done", null);
}

if (mode === "fresh") {
  const app = await buildApp();
  const res = await post(app, "registerPeer", { workspace_name: WORKSPACE, peer_id: id21("peer-fresh"), name: "peer-fresh" });
  say("write:fresh-owner", await outcome(res));
  say("done", null);
}

if (mode === "serialize") {
  const app = await buildApp();
  const COUNT = 12;
  const names = Array.from({ length: COUNT }, (_, i) => `peer-serial-${i}`);
  const ids = names.map((_, i) => id21(`peer-serial-${String(i).padStart(2, "0")}`));

  // Fire every write CONCURRENTLY: if the writer's serial queue (service.ts's
  // `core.serial`, ~line 1050) did not exist, these would race on the same
  // LanceDB table underneath one connection. This does not prove the absence
  // of a race by construction -- it proves the OBSERVABLE outcome the queue is
  // supposed to guarantee, run at N=12 concurrent requests through the wire.
  const started = Promise.all(
    names.map((name, i) => post(app, "registerPeer", { workspace_name: WORKSPACE, peer_id: ids[i], name })),
  );
  const results = await started;
  say(
    "write:concurrent",
    await Promise.all(results.map((res) => outcome(res))),
  );

  // Read every one back, also concurrently, through the same transport.
  const reads = await Promise.all(names.map((name) => post(app, "getPeer", { workspace_name: WORKSPACE, peer_name: name })));
  say("read:concurrent", await Promise.all(reads.map((res) => outcome(res))));
  say("done", null);
}
