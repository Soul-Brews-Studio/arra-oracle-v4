// R32 (docs/overnight/DECISIONS.md): `just up` must create BOTH a legacy-15
// root and a target-19 knowledge root, not just the legacy one -- otherwise
// a fresh install has no dataset /api/knowledge/* can open. This test runs
// the SAME script `just up` and `dev-stack.sh` both call
// (`just/scripts/create-both-roots.sh`) against a scratch `mktemp -d`
// (never `app/.tmp`, `app/data`, or `~/`), then starts the real server
// through the writer gate against the knowledge root it created and checks
// health plus one real knowledge method call end to end.
import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTimeout } from "../server/test/helpers/timing.testTimeout";

const APP = new URL("..", import.meta.url).pathname; // .../app/
const PY = join(APP, "migrate-py/.venv/bin/python");
const SCRIPTS = join(APP, "just/scripts");
const CREATE_BOTH = join(APP, "just/scripts/create-both-roots.sh");

const ROOT = mkdtempSync(join(tmpdir(), "arra-up-test."));
const LDATA = join(ROOT, "legacy");
const KDATA = join(ROOT, "knowledge");

let serverProc: ReturnType<typeof Bun.spawn> | undefined;

afterAll(async () => {
  serverProc?.kill();
  rmSync(ROOT, { recursive: true, force: true });
});

function laneTableCount(datasetRoot: string): number {
  return readdirSync(datasetRoot).filter((name) => name.endsWith(".lance")).length;
}

describe("just up -- both roots (R32)", () => {
  test(
    "create-both-roots.sh creates a 15-table legacy root and a 19-table knowledge root",
    async () => {
      const proc = Bun.spawn([CREATE_BOTH, LDATA, KDATA], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, `create-both-roots.sh failed:\nstdout: ${out}\nstderr: ${err}`).toBe(0);

      expect(laneTableCount(LDATA)).toBe(15);
      expect(laneTableCount(KDATA)).toBe(19);
    },
    testTimeout(60_000),
  );

  test(
    "re-running create-both-roots.sh against the same roots is idempotent",
    async () => {
      const proc = Bun.spawn([CREATE_BOTH, LDATA, KDATA], { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(laneTableCount(LDATA)).toBe(15);
      expect(laneTableCount(KDATA)).toBe(19);
    },
    testTimeout(60_000),
  );

  test(
    "the server started against the knowledge root serves health and a knowledge method",
    async () => {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const policyDir = ROOT;
      const write = Bun.spawnSync([PY, join(SCRIPTS, "write_dev_policy.py"), policyDir, "default", "up-test-operator"]);
      expect(write.exitCode, write.stderr.toString()).toBe(0);
      const token = await Bun.file(join(policyDir, "dev-token.txt")).text();

      serverProc = Bun.spawn([PY, join(SCRIPTS, "run_dev_server.py"), KDATA, join(APP, "server")], {
        env: {
          ...process.env,
          ARRA_AUTH_POLICY: join(policyDir, "dev-policy.json"),
          ARRA_ORIGIN: origin,
          PORT: String(port),
          ARRA_DATA_DIR: LDATA,
          ARRA_KNOWLEDGE_DATASET_ROOT: KDATA,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const deadline = Date.now() + testTimeout(20_000);
      let healthy = false;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${origin}/api/health?bank=default`, {
            headers: { authorization: `Bearer ${token.trim()}` },
          });
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {
          // server not up yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(healthy, "server never reported healthy on the knowledge root").toBe(true);

      const res = await fetch(`${origin}/api/knowledge/default/registerPeer`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.trim()}`, "content-type": "application/json" },
        body: JSON.stringify({ workspace_name: "default", peer_id: "a".repeat(21), name: "up-test-peer" }),
      });
      expect(res.status, await res.text().catch(() => "")).toBeLessThan(300);
    },
    testTimeout(30_000),
  );
});

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = server.port;
  server.stop(true);
  return port;
}
