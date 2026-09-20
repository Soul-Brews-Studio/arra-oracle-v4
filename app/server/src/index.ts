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

const bankQuery = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;

const queryInteger = (value: unknown, fallback: number, field: string) => {
  if (value === undefined) return { value: fallback } as const;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return { error: `${field} must be an integer between 1 and 1000` } as const;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1000
    ? ({ value: parsed } as const)
    : ({ error: `${field} must be an integer between 1 and 1000` } as const);
};

export const app = new Elysia()

  // ── MCP · per-bank, bank FIRST because it is the tenant (§3.1, §6.1) ──────
  //
  // The retired workspace segment is rejected explicitly: it never had room
  // semantics, so accepting it would claim a scope the dispatcher ignores.
  .post("/mcp/:bank", ({ body, params, request }) =>
    handleMcp(body, params.bank, request.headers.get("user-agent") ?? ""),
  )
  .post("/mcp/:bank/:workspace", ({ set }) => {
    set.status = 400;
    return { error: "workspace path segment is not supported; use /mcp/:bank" };
  })

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
  .get("/api/health", async ({ query, set }) => {
    try {
      const bank = bankQuery(query.bank);
      if (!bank) {
        set.status = 400;
        return { error: "bank is required" };
      }
      return { db: await store.stats(bank), embedder: await embedHealth() };
    } catch (e) {
      set.status = 503;
      return { error: String(e instanceof Error ? e.message : e) };
    }
  })
  .get("/api/memories", ({ query, set }) => {
    const bank = bankQuery(query.bank);
    if (!bank) {
      set.status = 400;
      return { error: "bank is required" };
    }
    const limit = queryInteger(query.limit, 50, "limit");
    if ("error" in limit) {
      set.status = 400;
      return limit;
    }
    return store.list(bank, limit.value);
  })
  .post("/api/memories", async ({ body, set }) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      set.status = 400;
      return { error: "body must be an object" };
    }
    const b = body as Record<string, unknown>;
    for (const field of ["workspace_name", "name", "content"] as const) {
      if (typeof b[field] !== "string" || !b[field].trim()) {
        set.status = 400;
        return { error: `${field} must be a non-blank string` };
      }
    }
    for (const field of ["type", "session_name", "peer_name", "subject_peer_name"] as const) {
      if (b[field] !== undefined && (typeof b[field] !== "string" || !b[field].trim())) {
        set.status = 400;
        return { error: `${field} must be a non-blank string` };
      }
    }
    if (typeof b.workspace_name !== "string" || typeof b.name !== "string" || typeof b.content !== "string") {
      set.status = 400;
      return { error: "workspace_name, name and content are required" };
    }
    set.status = 201;
    return store.insert({
      workspace_name: b.workspace_name,
      name: b.name,
      content: b.content,
      type: b.type as string | undefined,
      session_name: b.session_name as string | undefined,
      peer_name: b.peer_name as string | undefined,
      subject_peer_name: b.subject_peer_name as string | undefined,
    });
  })
  .get("/api/search", async ({ query, set }) => {
    const q = query.q;
    if (typeof q !== "string" || !q.trim()) {
      set.status = 400;
      return { error: "q is required" };
    }
    const mode = query.mode ?? "text";
    if (mode !== "text" && mode !== "vector") {
      set.status = 400;
      return { error: "mode must be 'text' or 'vector'" };
    }
    const bank = bankQuery(query.bank);
    if (!bank) {
      set.status = 400;
      return { error: "bank is required" };
    }
    const limit = queryInteger(query.limit, 10, "limit");
    if ("error" in limit) {
      set.status = 400;
      return limit;
    }
    const rows =
      mode === "vector"
        ? await store.searchVector(q, bank, limit.value)
        : await store.searchText(q, bank, limit.value);
    return { mode, q, bank: bank ?? null, count: rows.length, rows };
  })
  .post("/api/backfill", ({ query, set }) => {
    const batch = queryInteger(query.batch, 32, "batch");
    if ("error" in batch) {
      set.status = 400;
      return batch;
    }
    return store.backfill(batch.value);
  })
  .post("/api/reindex", async () => ({ indices: await store.ensureFtsIndex() }))

  .use(staticPlugin({ assets: "public", prefix: "/" }));

const port = Number(process.env.PORT ?? 3939);
if (import.meta.main) {
  // First boot must make keyword recall usable, including an empty dataset.
  // Do not rebuild an existing index on every restart or mutate from reads.
  await store.ensureFtsIndex(false);
  // Auth is not implemented yet: never expose this prototype on all interfaces.
  app.listen({ port, hostname: "127.0.0.1" });
  console.log(`${SERVER_NAME} ${SERVER_VERSION} on http://127.0.0.1:${port}`);
  console.log(`  MCP   POST /mcp/:bank   ${TOOLS.length} tools`);
  console.log(`  store ${storageInfo().uri} (${storageInfo().kind})`);
}
