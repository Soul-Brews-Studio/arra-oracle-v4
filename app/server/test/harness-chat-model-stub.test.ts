/**
 * R13 (CI must actually pass, docs/overnight/DECISIONS.md): the chat model
 * stub's teardown must never wait on a handler that can never finish.
 *
 * chat-model.test.ts's `afterAll(() => stub.stop(), 30_000)` timed out at
 * 30000 ms on the GitHub runner (run 36268048901, shard 2). Its "hang" test
 * leaves a request whose handler never settles. Measured on Bun 1.3.14: with
 * such a handler in flight, `server.stop(true)` resolves only if something
 * else wakes the event loop (a pending timer: ~35 ms); with nothing else
 * scheduled it never resolves (4/4). An `afterAll` has nothing else
 * scheduled. The stub now settles every request it holds when the client
 * aborts it and, at the latest, in `stop()` before the server stops.
 */

import { expect, test } from "bun:test";
import { startChatModelStub } from "./helpers/chat-model-stub";
import { testTimeout } from "./helpers/timing.testTimeout";

test("stop() resolves with a request still held and nothing else scheduled, and holds nothing after", async () => {
  const stub = startChatModelStub("hang");
  const answer = fetch(`${stub.url}/api/chat`, { method: "POST", body: "{}" }).then(
    () => "answered",
    () => "dropped",
  );
  // The request is genuinely held before the stub stops (a condition, not a race).
  while (stub.requests.length === 0) await Bun.sleep(5);
  // No timer or other work is pending past this point: before the fix this
  // await never returned.
  await stub.stop();
  expect(stub.held).toBe(0);
  // Settled either way: answered 503, or dropped by the forced close.
  expect(["answered", "dropped"]).toContain(await answer);
}, testTimeout(10_000));

test("a held request the client aborts is settled by the stub, before any stop", async () => {
  const stub = startChatModelStub("hang");
  try {
    const client = new AbortController();
    const answer = fetch(`${stub.url}/api/chat`, { method: "POST", body: "{}", signal: client.signal }).catch(
      (error: Error) => error.name,
    );
    while (stub.requests.length === 0) await Bun.sleep(5);
    expect(stub.held).toBe(1);
    client.abort();
    expect(await answer).toBe("AbortError");
    while (stub.held !== 0) await Bun.sleep(5);
    expect(stub.held).toBe(0);
  } finally {
    await stub.stop();
  }
}, testTimeout(10_000));
