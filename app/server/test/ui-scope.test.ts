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
    document, console, encodeURIComponent,
    fetch: async (path: string, opts?: RequestInit) => {
      calls.push({ path, method: opts?.method ?? "GET" });
      const url = new URL(path, "http://localhost");
      if (opts?.method === "POST" && failWrite) return Response.json({ error: "rejected" }, { status: 400 });
      if (url.pathname === "/api/health") return Response.json({ db: { rows: 0, embedded: 0, unembedded: 0, indices: [], version: 1 }, embedder: { ok: true, model: "test", dims: 384 } });
      if (url.pathname === "/api/search") return Response.json({ rows: [], count: 0, mode: "text", bank: url.searchParams.get("bank") });
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
