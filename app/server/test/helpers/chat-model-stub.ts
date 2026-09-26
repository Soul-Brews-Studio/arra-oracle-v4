/**
 * A RECORDING stand-in for a local Ollama `/api/chat` endpoint (#32, overnight
 * ruling R9, docs/overnight/DECISIONS.md).
 *
 * Bound to 127.0.0.1 on an ephemeral port and owned by the test that started
 * it. It is never a real model and never forwards anything: it records the
 * exact request text a production-composed server sent, so a test can prove
 * what did (and did not) reach the model, then answers with the evidence ids
 * it was shown, the way a well-behaved model cites them.
 *
 * `mode` is mutable so one stub can play "answers", "fails with 500" and
 * "never answers" in turn.
 *
 * R13 (docs/overnight/DECISIONS.md): "never answers" means for as long as
 * the client waits. A held request is settled (503) when its client aborts
 * and, at the latest, by `stop()` before the server stops. Measured on Bun
 * 1.3.14: with a never-settling handler in flight, `server.stop(true)` only
 * resolves if something else wakes the event loop -- with nothing else
 * scheduled it never does (4/4 locally), which is how chat-model.test.ts's
 * `afterAll` timed out at 30 s on the GitHub runner (run 36268048901).
 */

export type StubChatRequest = { readonly path: string; readonly text: string; readonly body: any };
export type StubMode = "ok" | "error" | "hang";

export type ChatModelStub = {
  readonly url: string;
  readonly requests: StubChatRequest[];
  mode: StubMode;
  /** Requests currently held by "hang" mode, not yet settled. */
  readonly held: number;
  stop(): Promise<void>;
};

/** Every 21-character id the prompt shows in square brackets, in order. */
const citedIds = (text: string): string[] => [...text.matchAll(/\[([A-Za-z0-9_-]{21})\]/g)].map((m) => m[1]!);

export function startChatModelStub(initial: StubMode = "ok"): ChatModelStub {
  const requests: StubChatRequest[] = [];
  const state = { mode: initial };
  const held = new Set<() => void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const text = await request.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      requests.push({ path: new URL(request.url).pathname, text, body });
      if (state.mode === "hang") {
        return new Promise<Response>((resolve) => {
          const release = () => {
            if (!held.delete(release)) return;
            resolve(new Response("stub released a held request", { status: 503 }));
          };
          held.add(release);
          request.signal.addEventListener("abort", release, { once: true });
        });
      }
      if (state.mode === "error") return new Response("model exploded", { status: 500 });
      const user = Array.isArray(body?.messages) ? String(body.messages.at(-1)?.content ?? "") : "";
      const ids = [...new Set(citedIds(user))];
      const content = `Stub answer from the recorded evidence ${ids.map((id) => `[${id}]`).join(" ")}`.trim();
      return Response.json({ model: body?.model ?? null, message: { role: "assistant", content }, done: true });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    get mode() {
      return state.mode;
    },
    set mode(value: StubMode) {
      state.mode = value;
    },
    get held() {
      return held.size;
    },
    stop: async () => {
      for (const release of [...held]) release();
      await server.stop(true);
    },
  };
}
