/**
 * Harness for the #34 copy-migration rehearsal tests.
 *
 * Everything is owned by the test that asked for it: a `mkdtemp` parent holds
 * the legacy source, the candidate, the work directory and a 0600 policy. The
 * real server is spawned as a child on a loopback port chosen here, and is
 * killed by exact PID and reaped. No existing dataset, no R2, no model.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";

import { TOKENS } from "./auth-fixture";
import { CHILD_DEADLINE_MS, PYTHON, runOwnedChild } from "./publication-fixture";

const REPO_ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const MIGRATE_DIR = join(REPO_ROOT, "app", "migrate-py");
const SERVER_DIR = join(REPO_ROOT, "app", "server");

export const TOKEN = TOKENS.alpha.secret;

/** sha256 of every file under `root`, keyed by relative path. */
export function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return out;
}

/** Build the realistic legacy-15 source with the Python fixture exporter. */
export async function buildLegacySource(sourceRoot: string): Promise<{ counts: Record<string, number> }> {
  const result = await runOwnedChild(PYTHON, [join("tests", "export_legacy_fixture.py"), sourceRoot], {
    cwd: MIGRATE_DIR,
  });
  if (result.code !== 0) throw new Error(`legacy fixture failed (${result.code}): ${result.stderr.slice(0, 600)}`);
  return JSON.parse(result.stdout);
}

/** Run the operator copy migration exactly as an operator would: the Python CLI. */
export async function runCopyMigration(
  args: { source: string; candidate: string; work: string; intakeAt: string },
): Promise<{ code: number; report: Record<string, any> | null; stderr: string }> {
  const result = await runOwnedChild(
    PYTHON,
    ["-m", "arra_migrate.copy_migration", "--source", args.source, "--candidate", args.candidate,
     "--work", args.work, "--intake-at", args.intakeAt],
    { cwd: MIGRATE_DIR, deadlineMs: 4 * CHILD_DEADLINE_MS },
  );
  let report: Record<string, any> | null = null;
  try {
    report = JSON.parse(readFileSync(join(args.work, "report.json"), "utf-8"));
  } catch {
    report = null;
  }
  return { code: result.code, report, stderr: result.stderr };
}

/** A policy granting read actions on the named workspaces, mode 0600. */
export async function writeReadPolicy(path: string, workspaces: string[]): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      version: "arra-auth/v1",
      principals: [{
        id: "migration-rehearsal",
        disabled: false,
        workspaces: workspaces.map((name) => ({
          name,
          actions: ["content:read", "diagnostics:read", "audit:read"],
        })),
        global_actions: [],
      }],
      credentials: [{
        id: "migration-rehearsal-cred",
        principal_id: "migration-rehearsal",
        sha256: TOKENS.alpha.sha256,
        not_before: "2026-01-01T00:00:00.000Z",
        expires_at: "2030-01-01T00:00:00.000Z",
        revoked: false,
      }],
    }),
    { encoding: "utf-8", mode: 0o600 },
  );
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

export type LiveServer = {
  base: string;
  mcp(bank: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  knowledge(bank: string, method: string, payload: Record<string, unknown>): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
};

/**
 * Start the REAL server entrypoint (`src/index.ts`) as a child.
 *
 * `dataDir` is the legacy ARRA_DATA_DIR; `knowledgeRoot` is optional, exactly
 * as in production. Readiness is the server's own startup line, bounded by a
 * deadline -- never a sleep guess.
 */
export async function startServer(
  opts: { dataDir: string; policyPath: string; knowledgeRoot?: string },
): Promise<LiveServer> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    ARRA_DATA_DIR: opts.dataDir,
    ARRA_AUTH_POLICY: opts.policyPath,
    PORT: String(port),
    // An address nothing listens on: recall stays on the text path and any
    // accidental embed call fails fast instead of reaching a real model.
    OLLAMA_URL: "http://127.0.0.1:9",
  };
  if (opts.knowledgeRoot) env.ARRA_KNOWLEDGE_DATASET_ROOT = opts.knowledgeRoot;
  const child: ChildProcess = spawn(process.execPath, ["src/index.ts"], {
    cwd: SERVER_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += String(chunk);
  });
  const exited = new Promise<void>((done) => child.once("close", () => done()));

  await new Promise<void>((ready, fail) => {
    let stdout = "";
    const timer = setTimeout(() => fail(new Error(`server not ready: ${stderr.slice(0, 600)}`)), CHILD_DEADLINE_MS);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.includes("arra-oracle-v4 on ")) {
        clearTimeout(timer);
        ready();
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited early (${code}): ${stderr.slice(0, 600)}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    base,
    async mcp(bank, tool, args) {
      const { status, body } = await post(`/mcp/${encodeURIComponent(bank)}`, {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args },
      });
      if (status !== 200 || body.result?.isError) throw new Error(`mcp ${tool}: ${status} ${JSON.stringify(body)}`);
      return JSON.parse(body.result.content[0].text);
    },
    knowledge(bank, method, payload) {
      return post(`/api/knowledge/${encodeURIComponent(bank)}/${method}`, payload);
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    },
  };
}
