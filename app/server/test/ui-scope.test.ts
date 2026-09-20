import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error("UI script missing");
function fixture(failWrite = false) {
  const elements: Record<string, any> = {};
  const calls: { path: string; method: string }[] = [];
  const document = { getElementById(id: string) { return elements[id] ??= { value: id === "mode" ? "text" : "", textContent: "", innerHTML: "", addEventListener() {} }; } };
  for (const match of html.matchAll(/id="([^\"]+)"/g)) document.getElementById(match[1]);
  const context = {
    document, console, encodeURIComponent, Headers, Response,
    fetch: async (path: string, opts?: RequestInit) => {
      calls.push({ path, method: opts?.method ?? "GET" });
      const url = new URL(path, "http://localhost");
      if (opts?.method === "POST" && failWrite) return Response.json({ error: "rejected" }, { status: 400 });
      if (url.pathname === "/api/health") return Response.json({ db: { rows: 0, embedded: 0, unembedded: 0 }, embedder: { ok: true, dims: 384 } });
      if (url.pathname === "/api/search") return Response.json({ rows: [], count: 0, mode: "text" });
      return Response.json(opts?.method === "POST" ? { id: "m_1", embedded: false } : []);
    },
  };
  runInNewContext(script!, context);
  return { elements, calls, context };
}
describe("current UI scoped HTTP contract", () => {
  test("initial health and list explicitly select a bank", async () => {
    const { calls } = fixture(); await Bun.sleep(0);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) expect(new URL(call.path, "http://localhost").searchParams.get("bank")).toBe("default");
  });
  test("empty read bank searches default; explicit read bank is escaped", async () => {
    const { elements, calls } = fixture(); elements.q.value = "memory";
    await elements.go.onclick();
    expect(new URL(calls.at(-1)!.path, "http://localhost").searchParams.get("bank")).toBe("default");
    elements.qbank.value = "neo/test"; await elements.go.onclick();
    expect(new URL(calls.at(-1)!.path, "http://localhost").searchParams.get("bank")).toBe("neo/test");
  });
  test("failed save preserves user text", async () => {
    const { elements } = fixture(true); elements.content.value = "do not lose this";
    await elements.add.onclick(); expect(elements.content.value).toBe("do not lose this");
    expect(elements.writeMsg.textContent).toContain("rejected");
  });
});

describe("browser credential handling (#25 §5)", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  /** Capture outbound headers so we can assert what the page actually sends. */
  function authFixture() {
    const elements: Record<string, any> = {};
    const sent: { path: string; authorization: string | null; redirect?: string; cache?: string }[] = [];
    const document = {
      getElementById(id: string) {
        return (elements[id] ??= {
          value: id === "mode" ? "text" : "",
          textContent: "",
          innerHTML: "",
          addEventListener() {},
        });
      },
    };
    for (const match of html.matchAll(/id="([^\"]+)"/g)) document.getElementById(match[1]);
    const context: Record<string, any> = {
      document,
      console,
      encodeURIComponent,
      Headers,
      Response,
      fetch: async (path: string, opts: any = {}) => {
        const headers = new Headers(opts.headers || {});
        sent.push({
          path,
          authorization: headers.get("authorization"),
          redirect: opts.redirect,
          cache: opts.cache,
        });
        const url = new URL(path, "http://localhost");
        if (url.pathname === "/api/health") {
          return Response.json({ db: { rows: 0, embedded: 0, unembedded: 0 }, embedder: { ok: true, dims: 384 } });
        }
        if (url.pathname === "/api/search") return Response.json({ rows: [], count: 0, mode: "text" });
        return Response.json(opts.method === "POST" ? { id: "m_1", embedded: false } : []);
      },
    };
    // `const` bindings in the page script do not become context properties the
    // way function declarations do, so the API is exported by a trailing
    // expression rather than fished off the context object.
    const api = runInNewContext(
      `${script}\n;({ setToken, logout, request, publicRequest })`,
      context,
    ) as {
      setToken(value: string): void;
      logout(): void;
      request(url: string, options?: unknown): Promise<unknown>;
      publicRequest(url: string): Promise<unknown>;
    };
    return { elements, sent, context, api };
  }

  test("no persistent storage API is referenced anywhere in the page", () => {
    for (const api of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "caches", "serviceWorker"]) {
      expect(html).not.toContain(api);
    }
  });

  test("the token is not embedded in the served asset", () => {
    expect(html).not.toContain(TOKEN);
    // The input is a password field and does not autocomplete into storage.
    expect(html).toContain('id="token"');
    expect(html).toContain('autocomplete="off"');
  });

  test("protected calls carry the in-memory token, with no-store and redirect refusal", async () => {
    const { elements, sent, api } = authFixture();
    api.setToken(TOKEN);
    await api.request("/api/memories?bank=alpha");
    const call = sent.at(-1)!;
    expect(call.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.redirect).toBe("error");
    expect(call.cache).toBe("no-store");
    expect(elements).toBeTruthy();
  });

  test("the wrapper reads the token at CALL time, so logout takes effect immediately", async () => {
    const { sent, api } = authFixture();
    api.setToken(TOKEN);
    await api.request("/api/memories?bank=alpha");
    expect(sent.at(-1)!.authorization).toBe(`Bearer ${TOKEN}`);
    api.logout();
    await api.request("/api/memories?bank=alpha");
    expect(sent.at(-1)!.authorization).toBeNull();
  });

  test("logout clears both the variable and the visible input value", () => {
    const { elements, api } = authFixture();
    elements.token.value = TOKEN;
    api.setToken(TOKEN);
    api.logout();
    expect(elements.token.value).toBe("");
  });

  test("public liveness sends no credential", async () => {
    const { sent, api } = authFixture();
    api.setToken(TOKEN);
    await api.publicRequest("/health");
    expect(sent.at(-1)!.authorization).toBeNull();
  });

  test("a 401 or 403 surfaces a generic access error, never the server's detail", async () => {
    const { context, api } = authFixture();
    api.setToken(TOKEN);
    context.fetch = async () =>
      Response.json({ error: "principal operator-b lacks content:read on alpha" }, { status: 403 });
    await expect(api.request("/api/memories?bank=alpha")).rejects.toThrow("access denied");
  });
});

describe("UI renders only fields the sanitized API actually returns", () => {
  test("the status bar never prints undefined from an absent field", async () => {
    // The page used to read e.model, d.version and d.indices, which the
    // sanitized diagnostics no longer return; the fixtures invented them, so
    // the tests hid it. Both sides now use the real shape.
    const { elements } = fixture();
    await Bun.sleep(0);
    expect(elements.bar.innerHTML).not.toContain("undefined");
    expect(elements.bar.innerHTML).toContain("rows");
  });

  test("search results never print undefined for the bank", async () => {
    const { elements } = fixture();
    elements.q.value = "anything";
    await elements.go.onclick();
    expect(elements.searchMsg.textContent).not.toContain("undefined");
    expect(elements.resultsTitle.textContent).not.toContain("undefined");
  });

  test("the page does not reference removed diagnostic fields", () => {
    for (const field of ["e.model", "d.version", "d.indices", "r.bank"]) {
      expect(script).not.toContain(field);
    }
  });
});
