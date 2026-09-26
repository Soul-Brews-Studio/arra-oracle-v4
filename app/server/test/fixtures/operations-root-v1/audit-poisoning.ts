// #103 fix-round BLOCKING finding (independent verifier, 2026-09-26), live.
//
// The R5 reader runs every operations-root `mcp_calls` row through the strict
// target19 codec (`encodeMcpCallRow` -> `storedName`: nonempty, at most 256
// UTF-8 bytes). The legacy writer stored the caller's `args.session_name` RAW
// on both the ok and the error path. So a caller holding only `content:read`
// -- not `audit:read` -- could send one `session_name` the codec rejects and
// turn `listMcpCalls` into 500 `integrity_failure` for the whole workspace,
// for every audit reader, permanently: keyset paging could never step past
// the row, so every LATER audit row was hidden too.
//
// Everything here goes through the real HTTP routes (`POST /mcp/:bank`,
// `POST /api/knowledge/:bank/listMcpCalls`) built by `buildApp`, plus the
// MCP adapter for `kb_listMcpCalls`. Registered LAST by `./inner.ts`: it
// adds `cred-ro` traffic to livealpha, which the order-dependent counts in
// `./live-transports.ts` must never see.
import { describe, expect, test } from "bun:test";
import { bearer, callRow, TOKENS } from "../../helpers/auth-fixture";
import type { OperationsRootFixture } from "./fixture";

/** 90 Thai characters: 270 UTF-8 bytes, over `storedName`'s 256-byte bound,
 *  yet a non-blank string the legacy tools accept without complaint. */
const LONG_THAI = "ก".repeat(90);

export function registerAuditPoisoningTests(fx: OperationsRootFixture): void {
  /** One JSON-RPC `tools/call` over the REAL `POST /mcp/:bank` route. */
  const mcpOverHttp = async (bank: string, token: string, name: string, args: Record<string, unknown>) => {
    const res = await fx.app.handle(
      new Request(`http://localhost/mcp/${bank}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearer(token), "user-agent": "poison-client/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  /** `listMcpCalls` over HTTP as the audit reader `cred-lister`. */
  const listOverHttp = async (bank: string, payload: Record<string, unknown>) => {
    const res = await fx.app.handle(
      new Request(`http://localhost/api/knowledge/${bank}/listMcpCalls`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: bearer(TOKENS.maint.secret) },
        body: JSON.stringify({ workspace_name: bank, after_id: null, limit: 50, tool: null, status: null, include_total: true, ...payload }),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  /** `kb_listMcpCalls` over MCP as `cred-lister`; returns the raw tool result. */
  const listOverMcp = async (bank: string, payload: Record<string, unknown>) => {
    const outcome = await fx.mcpHandle(
      bank,
      bearer(TOKENS.maint.secret),
      async () => ({
        method: "tools/call",
        id: 1,
        params: { name: "kb_listMcpCalls", arguments: { payload: { workspace_name: bank, after_id: null, limit: 50, tool: null, status: null, include_total: true, ...payload } } },
      }),
      "",
    );
    if (outcome.kind !== "response") throw new Error(`unexpected outcome ${outcome.kind}`);
    return (await outcome.response.json()).result as { isError?: boolean; content: { text: string }[] };
  };

  describe("#103 fix round: a content:read caller cannot poison the audit listing", () => {
    test("an EMPTY session_name sent over live MCP by a content:read-only credential never denies listMcpCalls", async () => {
      const before = await listOverHttp("livealpha", { tool: "list_memories" });
      expect(before.status).toBe(200);

      // The verifier's exact request: rejected by the tool's own validation,
      // but ADMITTED, so it is audited -- and it used to be audited raw.
      const poison = await mcpOverHttp("livealpha", TOKENS.beta.secret, "list_memories", { limit: 1, session_name: "" });
      expect(poison.status).toBe(200);
      expect(poison.body.result.isError).toBe(true);

      const after = await listOverHttp("livealpha", { tool: "list_memories" });
      expect(after.status).toBe(200);
      expect(after.body.unreadable).toBeUndefined();
      const row = after.body.rows.find((r: any) => JSON.parse(r.h_metadata).auth.credential_id === "cred-ro");
      expect(row).toMatchObject({ workspace_name: "livealpha", tool: "list_memories", status: "error", session_name: null });
      // Recorded as null WITH a flag, never silently: an auditor can tell
      // "no session given" from "an invalid session was refused".
      expect(JSON.parse(row.h_metadata).invalid_fields).toEqual(["session_name"]);

      const overMcp = await listOverMcp("livealpha", { tool: "list_memories" });
      expect(overMcp.isError).toBeUndefined();
      expect(JSON.parse(overMcp.content[0]!.text).total).toBe(after.body.total);
    });

    test("an over-long (270-byte Thai) session_name on a SUCCESSFUL call is recorded as null plus a flag, and the listing answers", async () => {
      const call = await mcpOverHttp("livealpha", TOKENS.beta.secret, "list_memories", { limit: 1, session_name: LONG_THAI });
      expect(call.status).toBe(200);
      expect(call.body.result.isError).toBeUndefined();

      const listed = await listOverHttp("livealpha", { tool: "list_memories", status: "ok" });
      expect(listed.status).toBe(200);
      expect(listed.body.unreadable).toBeUndefined();
      const row = listed.body.rows.find((r: any) => JSON.parse(r.h_metadata).auth.credential_id === "cred-ro");
      expect(row).toMatchObject({ status: "ok", session_name: null });
      const meta = JSON.parse(row.h_metadata);
      expect(meta.invalid_fields).toEqual(["session_name"]);
      // The attempted value is not lost: it survives inside the (redacted,
      // truncated, JSON-escaped) `input` the log always kept.
      expect(meta.input).toContain(LONG_THAI);
    });

    /**
     * Reader end. Rows the PRE-fix writer already stored raw stay in real
     * operations roots. Planted directly here, exactly as that writer left
     * them, between two healthy rows -- and listed over BOTH transports.
     */
    test("rows the pre-fix writer stored raw are withheld and reported, never a 500; paging walks past them on HTTP and MCP", async () => {
      const table = await fx.opsConnection.openTable("mcp_calls");
      const at = Date.now();
      await table.add([
        callRow("c_legacy_1", "livealpha", at, { tool: "bank_info", session_name: "fine" }),
        callRow("c_legacy_2", "livealpha", at, { tool: "bank_info", session_name: "" }),
        callRow("c_legacy_3", "livealpha", at, { tool: "bank_info", session_name: LONG_THAI }),
        callRow("c_legacy_4", "livealpha", at, { tool: "bank_info" }),
      ]);

      const listed = await listOverHttp("livealpha", { tool: "bank_info" });
      expect(listed.status).toBe(200);
      expect(listed.body.rows.map((r: any) => r.id)).toEqual(["c_legacy_1", "c_legacy_4"]);
      expect(listed.body.unreadable).toEqual([
        { id: "c_legacy_2", reason: "unencodable" },
        { id: "c_legacy_3", reason: "unencodable" },
      ]);
      expect(listed.body.total).toBe("4");

      const overMcp = await listOverMcp("livealpha", { tool: "bank_info" });
      expect(overMcp.isError).toBeUndefined();
      expect(JSON.parse(overMcp.content[0]!.text)).toEqual(listed.body);

      // Keyset walk at limit 1: every stored id exactly once, in order, and
      // the walk ENDS -- the bad rows no longer wall off what follows them.
      const seen: string[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page = await listOverHttp("livealpha", { tool: "bank_info", limit: 1, after_id: after });
        expect(page.status).toBe(200);
        seen.push(...page.body.rows.map((r: any) => r.id), ...(page.body.unreadable ?? []).map((u: any) => u.id));
        after = page.body.next_after_id;
        if (after === null) break;
      }
      expect(seen).toEqual(["c_legacy_1", "c_legacy_2", "c_legacy_3", "c_legacy_4"]);
    });
  });
}
