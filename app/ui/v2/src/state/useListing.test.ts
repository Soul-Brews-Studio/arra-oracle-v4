/** Failing-first (#33 AC2 round 3, nonblocking finding: "reverting ONLY
 *  useListing.ts brings back the false-empty 'no peers' and every test still
 *  passes"). `ListPanel.test.ts` hands `error` in as a prop and
 *  `listingErrorMessage.test.ts` tests the pure mapping, so nothing pinned the
 *  WIRING between them -- the one line in `useListing` that turns a failed
 *  page into `state.error`. This drives the real hook, over a stubbed `fetch`
 *  answering the auth gate's own 401/403 bodies, and reads `state.error`.
 *
 * No DOM and no new dependency: a hook is just a function that asks React's
 * current dispatcher for its state, so `runHook` below installs a tiny one
 * (useState/useRef/useMemo/useCallback/useEffect -- exactly what
 * `useListing` calls), runs effects after each render, and re-renders once
 * the stubbed fetch has resolved. `bun test src/state/useListing.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { authErrorHint } from "./authErrorHint";
import { useListing } from "./useListing";

type Slot = { v?: unknown; deps?: unknown[]; current?: unknown; set?: (u: unknown) => void };

function runHook<T>(hook: () => T) {
  const slots: Slot[] = [];
  const effects: Array<() => unknown> = [];
  let i = 0;
  const changed = (a?: unknown[], b?: unknown[]) =>
    a === undefined || b === undefined || a.length !== b.length || a.some((x, k) => !Object.is(x, b[k]));
  const dispatcher = {
    useState(init: unknown) {
      const k = i++;
      if (slots[k] === undefined) {
        const s: Slot = { v: typeof init === "function" ? (init as () => unknown)() : init };
        s.set = (u) => {
          s.v = typeof u === "function" ? (u as (p: unknown) => unknown)(s.v) : u;
        };
        slots[k] = s;
      }
      return [slots[k]!.v, slots[k]!.set];
    },
    useRef(init: unknown) {
      const k = i++;
      if (slots[k] === undefined) slots[k] = { current: init };
      return slots[k];
    },
    useMemo(f: () => unknown, deps: unknown[]) {
      const k = i++;
      if (slots[k] === undefined || changed(slots[k]!.deps, deps)) slots[k] = { v: f(), deps };
      return slots[k]!.v;
    },
    useCallback(f: unknown, deps: unknown[]) {
      return dispatcher.useMemo(() => f, deps);
    },
    useEffect(f: () => unknown, deps: unknown[]) {
      const k = i++;
      if (slots[k] === undefined || changed(slots[k]!.deps, deps)) {
        slots[k] = { deps };
        effects.push(f);
      }
    },
  };
  const internals = (React as unknown as Record<string, { ReactCurrentDispatcher: { current: unknown } }>)
    .__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED!;
  const render = (): T => {
    const prev = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    i = 0;
    try {
      return hook();
    } finally {
      internals.ReactCurrentDispatcher.current = prev;
      for (const f of effects.splice(0)) f();
    }
  };
  return render;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

const bank = { bank: "default", workspace: "default", token: "t" };

async function settle<T>(render: () => T): Promise<T> {
  render();
  for (let n = 0; n < 5; n++) await new Promise((r) => setTimeout(r, 0));
  return render();
}

describe("useListing wires a failed page's auth code into state.error", () => {
  test("403 forbidden: peers/sessions/nodes carry the forbidden hint, not a silent empty page", async () => {
    stubFetch(403, { error: "forbidden" });
    const hook = () => useListing(bank);
    const out = await settle(runHook(hook));
    for (const list of [out.peers, out.sessions, out.nodes]) {
      expect(list.state.rows).toEqual([]);
      expect(list.state.supported).toBe(true);
      expect(list.state.error).toBe(authErrorHint("forbidden"));
    }
  });

  test("401 unauthenticated: the token hint, distinct from the 403 one", async () => {
    stubFetch(401, { error: "unauthenticated" });
    const hook = () => useListing(bank);
    const out = await settle(runHook(hook));
    expect(out.peers.state.error).toBe(authErrorHint("unauthenticated"));
    expect(out.peers.state.error).not.toBe(authErrorHint("forbidden"));
  });

  test("a genuinely empty 200 page has no error (the honest zero still renders)", async () => {
    stubFetch(200, { rows: [], next_after_name: null, next_after_id: null, total: "0" });
    const hook = () => useListing(bank);
    const out = await settle(runHook(hook));
    expect(out.peers.state.error).toBeNull();
  });
});
