// The HTTP surface, as an Elysia app (SPEC §5.2).
//
// One Bun process: MCP endpoint, HTTP API, static UI. No sidecar, no
// docker-compose. Elysia is doing routing, not architecture — every handler is
// a few lines that calls the store and returns plain JSON.
//
// Swapped from Hono 2026-09-18 because §5.2 names Elysia and the fleet's other
// MCP server (digger-node) is already on it, so the auth plugin and OAuth AS
// port across rather than get rewritten.

import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import * as store from "./db";
import { health as embedHealth } from "./embed";
import { handleMcp } from "./mcp";
import { TOOLS } from "./mcp/tools";
import { SERVER_NAME, SERVER_VERSION, KNOWN_PROTOCOL_VERSIONS } from "./mcp/protocol";
import { storageInfo } from "./storage";

const app = new Elysia()

  // ── MCP · per-bank, bank FIRST because it is the tenant (§3.1, §6.1) ──────
  //
  // The optional workspace segment narrows the room, never the isolation. Both
  // shapes are declared rather than one wildcard, so a missing bank is a 404
  // and not a call against a bank named "undefined".
  .post("/mcp/:bank", ({ body, params, request }) =>
    handleMcp(body, params.bank, request.headers.get("user-agent") ?? ""),
  )
  .post("/mcp/:bank/:workspace", ({ body, params, request }) =>
    handleMcp(body, params.bank, request.headers.get("user-agent") ?? ""),
  )

  // ── health · names the doors rather than saying "ok" (§6.4) ───────────────
  .get("/health", async () => {
    const e = await embedHealth();
    return {
      version: `${SERVER_NAME} ${SERVER_VERSION}`,
      storage: storageInfo(),
      // Stated plainly: auth is SPECCED (§7) and NOT BUILT. A caller learns
      // that here rather than after ten minutes of OAuth debugging.
      auth: ["none — §7 not implemented"],
      embedder: e.ok ? `${e.model} (${e.dims}d)` : `DOWN: ${e.detail}`,
      mcp: { tools: TOOLS.length, protocols: KNOWN_PROTOCOL_VERSIONS },
    };
  })

  // ── HTTP API ──────────────────────────────────────────────────────────────
  .get("/api/health", async ({ set }) => {
    try {
      return { db: await store.stats(), embedder: await embedHealth() };
    } catch (e) {
      set.status = 503;
      return { error: String(e instanceof Error ? e.message : e) };
    }
  })
  .get("/api/memories", ({ query }) =>
    store.list(query.bank || undefined, Number(query.limit ?? 50)),
  )
  .post("/api/memories", async ({ body, set }) => {
    const b = body as any;
    if (!b?.content || !b?.name) {
      set.status = 400;
      return { error: "name and content are required" };
    }
    set.status = 201;
    return store.insert(b);
  })
  .get("/api/search", async ({ query, set }) => {
    const q = query.q;
    if (!q) {
      set.status = 400;
      return { error: "q is required" };
    }
    const mode = query.mode === "vector" ? "vector" : "text";
    const bank = query.bank || undefined;
    const limit = Number(query.limit ?? 10);
    const rows =
      mode === "vector"
        ? await store.searchVector(q, bank, limit)
        : await store.searchText(q, bank, limit);
    return { mode, q, bank: bank ?? null, count: rows.length, rows };
  })
  .post("/api/backfill", ({ query }) => store.backfill(Number(query.batch ?? 32)))
  .post("/api/reindex", async () => ({ indices: await store.ensureFtsIndex() }))

  .use(staticPlugin({ assets: "public", prefix: "/" }));

const port = Number(process.env.PORT ?? 3939);
app.listen(port);
console.log(`${SERVER_NAME} ${SERVER_VERSION} on http://127.0.0.1:${port}`);
console.log(`  MCP   POST /mcp/:bank[/:workspace]   ${TOOLS.length} tools`);
console.log(`  store ${storageInfo().uri} (${storageInfo().kind})`);
