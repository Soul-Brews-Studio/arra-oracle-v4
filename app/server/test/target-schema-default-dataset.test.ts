// R32 (Nat 2026-09-28, #135): a fresh v4 install starts on target-19.
//
// `python -m arra_migrate` with no flag must create a dataset the server's
// own `assertTargetDataset` accepts, and the real server -- started exactly
// the way `app/just/dev-stack.sh` starts it, through the writer gate
// (`run_dev_server.py` -> `exec_with_gate`) on a scratch port -- must serve
// `listMessages` and `getContext` over HTTP from it.
//
// The legacy `--legacy-active15` dataset is still created for ARRA_DATA_DIR:
// the legacy `/api/memories` routes and startup FTS work open its `memories`
// table (`db.db.ts`), and the operations tables (`mcp_calls`, `connections`)
// are written there (R5). That split is deliberate and stated in R32.
//
// Written BEFORE the default flipped: `python -m arra_migrate` created the 15
// legacy tables, so `assertTargetDataset` refused with `unsupported_dataset`.
//
// Everything lives under one fresh `mkdtemp` root; nothing touches app/data,
// app/.tmp, `~/` or a running service. No model is called: chat is left
// unconfigured and nothing here embeds.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { connect } from "@lancedb/lancedb";
import { assertTargetDataset } from "../src/publication/storage.assertTargetDataset";
import { TARGET_TABLES } from "../src/publication/storage.schema";
import { scaledMs } from "./helpers/timing.scaledMs";
import { testTimeout } from "./helpers/timing.testTimeout";

const APP = fileURLToPath(new URL("../..", import.meta.url));
const PY = process.env.ARRA_CONTRACT_PYTHON ?? join(APP, "migrate-py/.venv/bin/python");
const PY_SRC = join(APP, "migrate-py/src");
const SCRIPTS = join(APP, "just/scripts");
const SERVER_DIR = join(APP, "server");
const BANK = "default";

let root = "";
let knowledge = "";
let legacy = "";
let token = "";
let base = "";
let server: ReturnType<typeof Bun.spawn> | null = null;
let serverLog = "";

function python(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(PY, args, {
    env: { ...process.env, PYTHONPATH: PY_SRC, ARRA_RESET: "", ...env },
    encoding: "utf8",
    timeout: scaledMs(180_000),
  });
  if (result.status !== 0) throw new Error(`${args.join(" ")} exited ${result.status}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

async function post(method: string, body: unknown) {
  const res = await fetch(`${base}/api/knowledge/${BANK}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const nid = (seed: string) => (seed + "_".repeat(21)).slice(0, 21);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arra-target19-default-"));
  knowledge = join(root, "knowledge");
  legacy = join(root, "legacy");
  // The new default, then the explicit legacy flag -- the dev-stack order.
  python(["-m", "arra_migrate"], { ARRA_DATA_DIR: knowledge });
  python(["-m", "arra_migrate", "--legacy-active15"], { ARRA_DATA_DIR: legacy });
}, testTimeout(300_000));

afterAll(async () => {
  if (server) {
    server.kill("SIGTERM");
    await server.exited;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe("R32: the default migration creates a dataset the server accepts", () => {
  test("exactly the 19 target tables, and assertTargetDataset passes", async () => {
    const connection = await connect(knowledge);
    try {
      const names = await connection.tableNames({ limit: 1000 });
      expect([...names].sort()).toEqual([...TARGET_TABLES].sort());
      await assertTargetDataset(connection);
    } finally {
      connection.close();
    }
  });

  test("the legacy flag still creates the 15 tables the legacy routes open", async () => {
    const connection = await connect(legacy);
    try {
      const names = await connection.tableNames({ limit: 1000 });
      expect(names.length).toBe(15);
      expect(names).toContain("memories");
      expect(names).not.toContain("nodes");
    } finally {
      connection.close();
    }
  });
});

describe("R32: the real server starts on the fresh default dataset and serves context reads", () => {
  test("listMessages and getContext answer over HTTP on a scratch port", async () => {
    // The dev seed only adds the `default` workspace row: every table already
    // exists, so it must report `ok` for all 19 and create none.
    const seeded = python([join(SCRIPTS, "create_target19_dataset.py"), knowledge]);
    expect(seeded).not.toContain("created ");
    expect(seeded).toContain("seeded  workspaces row 'default'");
    python([join(SCRIPTS, "write_dev_policy.py"), root, BANK, "r32-operator"]);
    token = (await readFile(join(root, "dev-token.txt"), "utf8")).trim();

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn([PY, join(SCRIPTS, "run_dev_server.py"), knowledge, SERVER_DIR], {
      env: {
        ...process.env,
        PYTHONPATH: PY_SRC,
        PORT: String(port),
        ARRA_ORIGIN: base,
        ARRA_AUTH_POLICY: join(root, "dev-policy.json"),
        ARRA_DATA_DIR: legacy,
        ARRA_KNOWLEDGE_DATASET_ROOT: knowledge,
        // Empty means unconfigured: no model is ever contacted.
        ARRA_CHAT_PROVIDER: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    void new Response(server.stderr as ReadableStream).text().then((text) => (serverLog += text));

    const deadline = Date.now() + scaledMs(60_000);
    let healthy = false;
    while (Date.now() < deadline && !healthy) {
      try {
        const res = await fetch(`${base}/api/health?bank=${BANK}`, { headers: { authorization: `Bearer ${token}` } });
        healthy = res.status === 200;
      } catch {
        // not listening yet
      }
      if (!healthy) await Bun.sleep(100);
    }
    expect(healthy, `server never became healthy: ${serverLog.slice(0, 2000)}`).toBe(true);

    const peerA = nid("r32peeralice"), peerB = nid("r32peerbob"), sessionId = nid("r32session");
    for (const [method, body] of [
      ["registerPeer", { workspace_name: BANK, peer_id: peerA, name: "alice" }],
      ["registerPeer", { workspace_name: BANK, peer_id: peerB, name: "bob" }],
      ["registerSession", { workspace_name: BANK, session_id: sessionId, name: "sess-a" }],
      ["joinSession", { workspace_name: BANK, session_name: "sess-a", peer_name: "alice" }],
      ["joinSession", { workspace_name: BANK, session_name: "sess-a", peer_name: "bob" }],
      ["appendMessages", {
        workspace_name: BANK,
        session_name: "sess-a",
        items: [1, 2].map((i) => ({
          public_id: nid(`r32message${i}`),
          message: { peer_name: i === 1 ? "alice" : "bob", role: i === 1 ? "user" : "assistant", content: `r32 message ${i}`, in_reply_to: null },
          source: null,
        })),
      }],
    ] as const) {
      const res = await post(method, body);
      expect(res.status, `${method}: ${JSON.stringify(res.body)}`).toBe(200);
    }

    const listed = await post("listMessages", { workspace_name: BANK, session_name: "sess-a", after_seq: null, limit: 10 });
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.rows.map((row: { content: string }) => row.content)).toEqual(["r32 message 1", "r32 message 2"]);

    const context = await post("getContext", { workspace_name: BANK, peer_name: "alice", session_name: "sess-a", max_items: 10 });
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(Array.isArray(context.body.items)).toBe(true);
    expect(typeof context.body.coverage).toBe("string");
  }, testTimeout(300_000));
});
