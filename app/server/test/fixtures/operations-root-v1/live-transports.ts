// Live HTTP + MCP scenarios for the operations-root readers (#103 / #102,
// DECISIONS.md R5), with the knowledge dataset and the operations root on
// DISTINCT physical roots. Registered by `./inner.ts`; the tests in here are
// ORDER-DEPENDENT on purpose (the third re-uses the counts the first one
// settled), which is why they share one `describe` and one process.
import { connect } from "@lancedb/lancedb";
import { describe, expect, test } from "bun:test";
import { bearer, TOKENS } from "../../helpers/auth-fixture";
import type { OperationsRootFixture } from "./fixture";

/**
 * `foldConnection` runs fire-and-forget from `composition.ts`'s `logCall`
 * wrapper -- the MCP response returns as soon as `calls.logCall` (the
 * AWAITED half) resolves, with no guarantee the fold's own read-modify-write
 * has finished. That is existing, unchanged production behaviour, so the
 * tests poll the reader directly rather than assuming a synchronous write. A
 * real `integrity_failure` while polling is a genuine regression and fails
 * the test: overlapping folds for one id are queued (`connections.ts`'s
 * `foldQueues`), so a page is either not caught up yet or already correct.
 */
async function waitFor<T>(check: () => Promise<T | null>, timeoutMs = 3000, intervalMs = 20): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (Date.now() > deadline) throw new Error("waitFor: timed out waiting for the connection fold to settle");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function registerLiveTransportTests(fx: OperationsRootFixture): void {
  describe("live HTTP + MCP, distinct data roots (R5)", () => {
    test("the target19 knowledge root's own copies stay empty (#34 not migrated yet)", async () => {
      const knowledgeConnection = await connect(fx.knowledge.datasetRoot);
      const knowledgeCalls = await (await knowledgeConnection.openTable("mcp_calls")).countRows();
      const knowledgeConns = await (await knowledgeConnection.openTable("connections")).countRows();
      expect(knowledgeCalls).toBe(0);
      expect(knowledgeConns).toBe(0);
    });

    /** One real, admitted, audited `tools/call`. */
    const rpc = async (bank: string, token: string, args: Record<string, unknown>, ua = "test-client/1.0") => {
      const outcome = await fx.mcpHandle(bank, bearer(token), async () => ({ method: "tools/call", id: 1, params: { name: "call_log", arguments: args } }), ua);
      if (outcome.kind !== "response") throw new Error(`unexpected outcome ${outcome.kind}`);
      return outcome.response.json() as Promise<any>;
    };

    /** A `kb_*` listing over MCP as `cred-lister` -- never as `cred-a`, whose
     *  counts these tests assert on (a listing is itself an audited call). */
    const listOverMcp = async (tool: "kb_listMcpCalls" | "kb_listConnections", bank: string, payload: Record<string, unknown>) => {
      const outcome = await fx.mcpHandle(
        bank,
        bearer(TOKENS.maint.secret),
        async () => ({ method: "tools/call", id: 1, params: { name: tool, arguments: { payload: { workspace_name: bank, after_id: null, limit: 50, include_total: true, ...payload } } } }),
        "",
      );
      if (outcome.kind !== "response") throw new Error(`unexpected outcome ${outcome.kind}`);
      const body = await outcome.response.json();
      return JSON.parse(body.result.content[0].text);
    };

    /**
     * Poll the operations root DIRECTLY (never through MCP -- listing over MCP
     * is itself an audited call and would perturb the very state being
     * awaited) until `principal`'s folded row shows exactly `expectedRequests`.
     */
    const settledConnectionsRow = (bank: string, principal: string, expectedRequests: number) =>
      waitFor(async () => {
        const page = await fx.opsListConnections(fx.connectionsRequest(bank));
        const row = page.rows.find((r) => r.principal === principal);
        return row !== undefined && row.requests === String(expectedRequests) ? row : null;
      });

    test("a live success AND a live failure each appear exactly once in listMcpCalls, never in the other workspace's list", async () => {
      // Two admitted, audited calls on livealpha: one succeeds, one fails
      // validation inside `dispatchTool` -- both still reach `appendAudit`.
      const ok = await rpc("livealpha", TOKENS.alpha.secret, { limit: 5 });
      expect(ok.result?.isError).toBeUndefined();
      const failed = await rpc("livealpha", TOKENS.alpha.secret, { status: "bogus" });
      expect(failed.result?.isError).toBe(true);
      await settledConnectionsRow("livealpha", "cred-a", 2);
      // One admitted call on livebeta, so its list is exactly one row.
      await rpc("livebeta", TOKENS.alpha.secret, { limit: 5 });
      await settledConnectionsRow("livebeta", "cred-a", 1);

      // Filtering `tool: "call_log"` excludes the listing's own
      // `kb_listMcpCalls` rows either way; listing as `cred-lister` also keeps
      // this test from folding a THIRD event onto `cred-a`'s checked row.
      const alphaOverMcp = await listOverMcp("kb_listMcpCalls", "livealpha", { tool: "call_log", status: null });
      expect(alphaOverMcp.total).toBe("2");
      expect(alphaOverMcp.rows.map((r: any) => r.status).sort()).toEqual(["error", "ok"]);
      expect(alphaOverMcp.rows.every((r: any) => r.workspace_name === "livealpha")).toBe(true);

      const httpRes = await fx.app.handle(
        new Request("http://localhost/api/knowledge/livealpha/listMcpCalls", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer(TOKENS.maint.secret) },
          body: JSON.stringify({ workspace_name: "livealpha", after_id: null, limit: 50, tool: "call_log", status: null, include_total: true }),
        }),
      );
      expect(httpRes.status).toBe(200);
      const httpBody = await httpRes.json();
      expect(httpBody.total).toBe("2");
      expect(httpBody.rows.map((r: any) => r.status).sort()).toEqual(["error", "ok"]);

      const betaOverMcp = await listOverMcp("kb_listMcpCalls", "livebeta", { tool: "call_log", status: null });
      expect(betaOverMcp.total).toBe("1");
      expect(betaOverMcp.rows.every((r: any) => r.workspace_name === "livebeta")).toBe(true);
      // Isolation: livebeta's row id never appears on livealpha's page.
      const betaIds = new Set(betaOverMcp.rows.map((r: any) => r.id));
      expect(alphaOverMcp.rows.some((r: any) => betaIds.has(r.id))).toBe(false);
    });

    test("listConnections folds livealpha's two calls into one row keyed by credential_id, distinct from livebeta's, over MCP and HTTP", async () => {
      // The previous test already drove these to the expected counts and
      // waited for them to settle; re-confirm rather than re-wait, so a
      // regression here fails fast instead of hanging on `waitFor`'s timeout.
      const alphaDirect = await fx.opsListConnections(fx.connectionsRequest("livealpha"));
      expect(alphaDirect.rows.find((r) => r.principal === "cred-a")?.requests).toBe("2");

      const alpha = await listOverMcp("kb_listConnections", "livealpha", {});
      const row = alpha.rows.find((r: any) => r.principal === "cred-a");
      expect(row).toBeDefined();
      expect(row.workspace_name).toBe("livealpha");
      // DECISIONS.md R5: `principal` is the CREDENTIAL id ("cred-a"), never
      // the principal id ("person-a") the credential belongs to.
      expect(row.principal).toBe("cred-a");
      expect(row.principal).not.toBe("person-a");
      // DECISIONS.md R19: `method` is the AUTH method of SPEC §7.2 (bearer | oauth |
      // owner-session). Every admitted request today came through an arra-auth/v1
      // bearer credential, so it is "bearer" -- never "unknown", never a transport.
      expect(row.method).toBe("bearer");
      expect(row.label).toBe("test-client/1.0");
      expect(row.requests).toBe("2");
      expect(row.tool_calls).toBe("2");
      expect(row.remote_ip).toBeNull();
      expect(Number.isNaN(Date.parse(row.first_seen as string))).toBe(false);
      expect(Number.isNaN(Date.parse(row.last_seen as string))).toBe(false);

      const beta = await listOverMcp("kb_listConnections", "livebeta", {});
      const betaRow = beta.rows.find((r: any) => r.principal === "cred-a");
      expect(betaRow).toBeDefined();
      expect(betaRow.workspace_name).toBe("livebeta");
      expect(betaRow.id).not.toBe(row.id);

      // Same admitted caller, same expected row, over the OTHER transport.
      const httpRes = await fx.app.handle(
        new Request("http://localhost/api/knowledge/livealpha/listConnections", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer(TOKENS.maint.secret) },
          body: JSON.stringify({ workspace_name: "livealpha", after_id: null, limit: 50, include_total: true }),
        }),
      );
      expect(httpRes.status).toBe(200);
      const httpBody = await httpRes.json();
      const httpRow = httpBody.rows.find((r: any) => r.principal === "cred-a");
      expect(httpRow).toMatchObject({ workspace_name: "livealpha", principal: "cred-a", requests: "2", tool_calls: "2" });
    });

    /**
     * The scenario the #102 fix-round verifier measured live: several MCP
     * `tools/call` requests from ONE client, back-to-back, with NO settle-wait
     * between them. Before the concurrency fix this produced duplicate-id rows
     * and `listConnections` answered 500 `integrity_failure` for the WHOLE
     * workspace on every poll.
     */
    test("back-to-back MCP calls from one client, with no settle-wait between them, never break listConnections for the workspace", async () => {
      for (let i = 0; i < 5; i++) {
        const result = await rpc("livealpha", TOKENS.alpha.secret, { limit: 5 + i });
        expect(result.result?.isError).toBeUndefined();
      }

      const row = await settledConnectionsRow("livealpha", "cred-a", 2 + 5); // 2 from the earlier test + 5 here
      expect(row.requests).toBe("7");

      const raw = (await (await fx.opsConnection.openTable("connections"))
        .query()
        .where(`workspace_name = 'livealpha' AND principal = 'cred-a'`)
        .toArray()) as Record<string, unknown>[];
      expect(raw).toHaveLength(1);
    });

    test("a caller without audit:read is denied on both transports, unchanged", async () => {
      const outcome = await fx.mcpHandle(
        "livealpha",
        bearer(TOKENS.beta.secret),
        async () => ({ method: "tools/call", id: 1, params: { name: "kb_listMcpCalls", arguments: { payload: { workspace_name: "livealpha", after_id: null, limit: 50, tool: null, status: null, include_total: true } } } }),
        "",
      );
      expect(outcome.kind).toBe("denied");
      expect(outcome.kind === "denied" && outcome.code).toBe("forbidden");

      const httpRes = await fx.app.handle(
        new Request("http://localhost/api/knowledge/livealpha/listMcpCalls", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: bearer(TOKENS.beta.secret) },
          body: JSON.stringify({ workspace_name: "livealpha", after_id: null, limit: 50, tool: null, status: null, include_total: true }),
        }),
      );
      expect(httpRes.status).toBe(403);
    });
  });
}
