// Keeps `app/just/demo.sh` honest in CI with no real model: a `Bun.serve`
// stub stands in for Ollama (`DEMO_OLLAMA_URL`, read by `lib.sh`'s
// `resolve_ollama` and passed through to the server as `OLLAMA_URL`, which
// both `embed.ts` and `chat-model.readChatConfig` already default from) and
// this file runs the REAL script end to end against it, then asserts every
// step's `STEP_OK` / `STEP_SKIPPED` marker (`lib.sh`'s `ok`/`skip`/`fail`)
// appears with none of them a `STEP_FAIL`.
//
// This never touches a real Ollama and never asserts anything about model
// QUALITY -- it proves the WIRING (every request the script drives reaches
// a server, which reaches the configured model URL, and the shapes match),
// the same boundary `test/fixtures/chat-v1/gated-chat.ts` stubs for the
// unit-level chat tests. `docs/overnight/DEMO.md` is the real-model
// transcript; this is the one that runs without a GPU.
import { afterAll, describe, expect, test } from "bun:test";

const DEMO_SH = new URL("./demo.sh", import.meta.url).pathname;
const APP_ROOT = new URL("..", import.meta.url).pathname; // .../app/

/** A syntactically valid Ollama model digest (`MODEL_DIGEST_PATTERN`,
 *  `search-chunk.fetchOllamaModelDigest.ts`): 64 lowercase hex characters.
 *  Not a real digest -- this dataset never talks to a real model. */
const STUB_DIGEST = "deadbeef".repeat(8);

/** A fixed-length, all-finite, Float32-safe vector -- everything
 *  `embed.ts`'s own response validation checks for, nothing more. */
const stubVector = () => new Array(384).fill(0.001);

type OllamaCall = { path: string; body: unknown };

/** One stub Ollama serving exactly the three endpoints this codebase's
 *  server ever calls (`embed.ts` /api/embed, `fetchOllamaModelDigest.ts`
 *  /api/tags, `chat-model.createOllamaChatModel.ts` /api/chat) -- see that
 *  trio named together in `stack.sh`'s own header comment. */
function startOllamaStub() {
  const calls: OllamaCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/api/tags" && req.method === "GET") {
        return Response.json({ models: [{ name: "all-minilm", digest: STUB_DIGEST }] });
      }
      if (url.pathname === "/api/embed" && req.method === "POST") {
        const input = (body as { input?: unknown })?.input;
        const n = Array.isArray(input) ? input.length : 0;
        return Response.json({ embeddings: Array.from({ length: n }, stubVector) });
      }
      if (url.pathname === "/api/chat" && req.method === "POST") {
        return Response.json({ message: { content: "stubbed answer: no real model was contacted." } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

/** Run the real `demo.sh`, stdout+stderr merged (the script itself never
 *  merges them; `2>&1` here matches how a human reading a terminal would
 *  see it). `env` overrides/extends the current process env. */
async function runDemo(env: Record<string, string>) {
  const proc = Bun.spawn(["bash", "-c", `bash ${DEMO_SH} 2>&1`], {
    cwd: APP_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit", // unreachable: the -c wrapper already merged stderr into stdout
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { out, exitCode };
}

const EVERY_STEP = [
  "register-peers", "open-session", "append-messages", "seed-vocab", "lookup-type-term",
  "publish-node", "index-chunks", "search-freshness", "keyword-search", "get-context",
  "supersede-node", "nodes-list-default", "nodes-list-history",
  "v3-tools-list", "v3-oracle-learn", "v3-oracle-search", "v3-oracle-thread", "v3-oracle-thread-read",
];
const MODEL_STEPS = ["embed-chunks", "semantic-search", "chat-ask"];

describe("app/just/demo.sh (stubbed Ollama)", () => {
  test("every step OK when the stub answers -- proves the model wiring end to end", async () => {
    const stub = startOllamaStub();
    try {
      const { out, exitCode } = await runDemo({ DEMO_OLLAMA_URL: stub.url });
      expect(exitCode, out).toBe(0);
      expect(out).toContain("DEMO_DONE");
      expect(out).not.toContain("STEP_FAIL");
      for (const name of [...EVERY_STEP, ...MODEL_STEPS]) {
        expect(out, out).toContain(`STEP_OK ${name}`);
      }
      // The model steps must have gone through the ACTUAL stub, not just
      // printed a success line with nothing behind it.
      const paths = stub.calls.map((c) => c.path);
      expect(paths).toContain("/api/tags");
      expect(paths).toContain("/api/embed");
      expect(paths).toContain("/api/chat");
    } finally {
      stub.stop();
    }
  }, 60_000);

  test("model steps SKIP with an honest reason when Ollama is unreachable -- nothing is faked", async () => {
    // A closed local port: nothing in this suite ever binds it, so the
    // connection is refused immediately rather than timing out.
    const { out, exitCode } = await runDemo({ DEMO_OLLAMA_URL: "http://127.0.0.1:1" });
    expect(exitCode, out).toBe(0);
    expect(out).toContain("DEMO_DONE");
    expect(out).not.toContain("STEP_FAIL");
    expect(out).toContain("Ollama UNREACHABLE at http://127.0.0.1:1");
    for (const name of MODEL_STEPS) {
      expect(out, out).toContain(`STEP_SKIPPED ${name} (Ollama unreachable at http://127.0.0.1:1)`);
    }
    // Everything that does NOT need a model still ran for real.
    for (const name of EVERY_STEP) {
      expect(out, out).toContain(`STEP_OK ${name}`);
    }
  }, 60_000);
});
