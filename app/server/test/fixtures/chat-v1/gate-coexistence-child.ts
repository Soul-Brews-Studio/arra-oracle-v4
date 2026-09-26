// Owned test child for #32 slice A (overnight ruling R9): chat and writes
// must coexist in ONE gated server process.
//
// Runs INSIDE the real writer gate (`runGated` -> `exec_with_gate`, fd 42),
// exactly as `run_dev_server.py` runs the dev server. It builds the SAME
// production composition `index.ts`'s `buildApp` builds -- `composeKnowledgeAccess`
// over this process's env (dataset root + ARRA_CHAT_* pointing at the parent's
// recording stub), `createApp`, the real MCP adapter -- then drives an ordered
// list of HTTP and MCP calls through `app.handle` and prints one JSON line:
// the status and governed error code of every step, in order.
//
// No fakes: the bundle, the gate, the policy file and the transports are all
// real. Only the model is a stub, and it lives in the PARENT process.
const [, , policyPath, phase] = Bun.argv;

const SRC = new URL("../../../src/", import.meta.url).pathname;
const { composeKnowledgeAccess } = await import(`${SRC}composition.ts`);
const { createApp } = await import(`${SRC}app.ts`);
const { createOperationService } = await import(`${SRC}auth/service.ts`);
const { configureKnowledgeAccess, createMcpAdapter } = await import(`${SRC}mcp/index.ts`);

const ORIGIN = "http://127.0.0.1:3939";
const WS = "alpha-workspace";
const TOKEN = process.env.COEXIST_TOKEN!;
const pad = (seed: string) => `${seed}${"0".repeat(Math.max(0, 21 - seed.length))}`.slice(0, 21);

// `await` on purpose: the composition may be sync or async, and this child
// must run unchanged against either.
const access = await composeKnowledgeAccess(process.env);
configureKnowledgeAccess(access);
const service = createOperationService({ policyPath: policyPath! }, { logCall: async () => {} } as never);
const app = createApp({ origin: ORIGIN }, service, createMcpAdapter(service), {
  knowledge: { policyPath: policyPath!, access },
});

const headers = { host: "127.0.0.1:3939", authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

type Step = { label: string; status: number; ok: boolean; code: string | null; answer?: string; items_used?: string[] };
const steps: Step[] = [];

const codeOf = (value: unknown): string | null =>
  typeof value === "object" && value !== null && typeof (value as { code?: unknown }).code === "string"
    ? (value as { code: string }).code
    : null;

async function http(label: string, method: string, body: Record<string, unknown>) {
  const res = await app.handle(
    new Request(`${ORIGIN}/api/knowledge/${WS}/${method}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
  const text = await res.text();
  let value: any = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  steps.push({
    label,
    status: res.status,
    ok: res.status === 200,
    code: res.status === 200 ? null : codeOf(value),
    ...(typeof value?.answer === "string" ? { answer: value.answer, items_used: value.items_used } : {}),
  });
}

async function mcp(label: string, method: string, payload: Record<string, unknown>) {
  const res = await app.handle(
    new Request(`${ORIGIN}/mcp/${WS}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `kb_${method}`, arguments: { payload } } }),
    }),
  );
  const envelope = (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] } };
  const text = envelope.result?.content?.[0]?.text ?? "";
  let value: any = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  const isError = envelope.result?.isError === true;
  steps.push({
    label,
    status: res.status,
    ok: res.status === 200 && !isError,
    code: isError ? codeOf(value) ?? String(value) : null,
    ...(typeof value?.answer === "string" ? { answer: value.answer, items_used: value.items_used } : {}),
  });
}

const ask = { workspace_name: WS, peer_name: "peer-a", session_name: "main", question: "What was recorded?", max_items: 10 };
const append = (id: string, content: string) => ({
  workspace_name: WS,
  session_name: "main",
  items: [{ public_id: pad(id), message: { peer_name: "peer-a", role: null, content, in_reply_to: null }, source: null }],
});

try {
  if (phase === "write-first") {
    // Writes first: the cached process-lifetime writer is opened and HELD.
    await http("write:registerPeer", "registerPeer", { workspace_name: WS, peer_id: pad("peera"), name: "peer-a" });
    await http("write:registerSession", "registerSession", { workspace_name: WS, session_id: pad("sessmain"), name: "main" });
    await http("write:joinSession", "joinSession", { workspace_name: WS, session_name: "main", peer_name: "peer-a" });
    await http("write:append1", "appendMessages", append("coexist1", "the first recorded fact"));
    // ...then chat on the SAME process, three times, then another write.
    await http("ask:1", "answerChat", ask);
    await http("ask:2", "answerChat", ask);
    await http("ask:3", "answerChat", ask);
    await http("write:append2", "appendMessages", append("coexist2", "written after three answers"));
  } else {
    // A FRESH process whose very first call is chat: nothing has opened the
    // writer yet, so this is the order that used to release the inherited gate.
    await http("ask:first", "answerChat", ask);
    await http("write:after-ask", "appendMessages", append("coexist3", "written after the first answer"));
    await http("ask:a", "answerChat", ask);
    await http("ask:b", "answerChat", ask);
    await http("ask:c", "answerChat", ask);
    await http("write:after-three", "registerPeer", { workspace_name: WS, peer_id: pad("peerb"), name: "peer-b" });
    // The same order over MCP, on the same process and access.
    await mcp("mcp:ask", "answerChat", ask);
    await mcp("mcp:write", "appendMessages", append("coexist4", "written over MCP after an MCP answer"));
  }
} catch (error) {
  steps.push({ label: "THREW", status: -1, ok: false, code: String((error as Error)?.message ?? error) });
} finally {
  configureKnowledgeAccess(null);
}

// Exit explicitly: the cached writer is process-lifetime by design and is
// released by process exit, exactly as in the dev server.
await Bun.write(Bun.stdout, `${JSON.stringify({ phase, steps })}\n`);
process.exit(0);
