import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import * as store from "./db";
import { health as embedHealth } from "./embed";

const app = new Hono();

app.get("/api/health", async (c) => {
  try {
    return c.json({ db: await store.stats(), embedder: await embedHealth() });
  } catch (e) {
    return c.json({ error: String(e instanceof Error ? e.message : e) }, 503);
  }
});

app.get("/api/memories", async (c) => {
  const bank = c.req.query("bank") || undefined;
  return c.json(await store.list(bank, Number(c.req.query("limit") ?? 50)));
});

app.post("/api/memories", async (c) => {
  const body = await c.req.json();
  if (!body?.content || !body?.name) return c.json({ error: "name and content are required" }, 400);
  return c.json(await store.insert(body), 201);
});

app.get("/api/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q is required" }, 400);
  const mode = c.req.query("mode") === "vector" ? "vector" : "text";
  const bank = c.req.query("bank") || undefined;
  const limit = Number(c.req.query("limit") ?? 10);
  const rows = mode === "vector"
    ? await store.searchVector(q, bank, limit)
    : await store.searchText(q, bank, limit);
  return c.json({ mode, q, bank: bank ?? null, count: rows.length, rows });
});

app.post("/api/backfill", async (c) => c.json(await store.backfill(Number(c.req.query("batch") ?? 32))));

app.post("/api/reindex", async (c) => c.json({ indices: await store.ensureFtsIndex() }));

app.use("/*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT ?? 3939);
console.log(`arra-v4 poc on http://127.0.0.1:${port}`);

export default { port, fetch: app.fetch };
