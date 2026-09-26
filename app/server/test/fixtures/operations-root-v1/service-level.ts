// Service-level scenarios for the operations-root readers and writers
// (#103 / #102, DECISIONS.md R5): the functions are called directly, no
// transport. Registered by `./inner.ts`, which owns the process and the
// fixture -- see that file's header for why none of this may run in a shared
// `bun test` process.
import { describe, expect, test } from "bun:test";
import { callRow } from "../../helpers/auth-fixture";
import type { OperationsRootFixture } from "./fixture";

/** The fold key exactly as `connections.ts` derives it -- so a test can plant
 *  rows the way a SECOND writer process (or the pre-R5 writer) left them. */
const foldIdFor = (workspace: string, method: string, principal: string, label: string) =>
  `k_${Buffer.from([workspace, method, principal, label].join("\u001f"), "utf8").toString("base64url")}`;

/** One `connections` row as the table stores it (millis in a `timestamp[us]`
 *  column -- see the measurement table in `connections.ts`'s fold). */
const connectionRow = (id: string, workspace: string, principal: string, requests: number, overrides: Record<string, unknown> = {}) => ({
  id,
  workspace_name: workspace,
  method: "unknown",
  principal,
  label: "client/1.0",
  user_agent: "client/1.0",
  remote_ip: null,
  first_seen: 1_790_000_000_000,
  last_seen: 1_790_000_000_000,
  requests: BigInt(requests),
  tool_calls: BigInt(requests),
  last_tool: "recall",
  ...overrides,
});

export function registerServiceLevelTests(fx: OperationsRootFixture): void {
  describe("service level: listMcpCalls reads the operations root directly", () => {
    test("pagination, filters and total all scope to one workspace", async () => {
      const table = await fx.opsConnection.openTable("mcp_calls");
      await table.add([
        callRow("c1", "svc-alpha", 100, { status: "ok", tool: "recall" }),
        callRow("c2", "svc-alpha", 200, { status: "error", tool: "remember" }),
        callRow("c3", "svc-alpha", 300, { status: "ok", tool: "recall" }),
        callRow("cx", "svc-beta", 400, { status: "ok", tool: "recall" }),
      ]);

      const page1 = await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-alpha", { limit: 2 }));
      expect(page1.rows.map((r) => r.id)).toEqual(["c1", "c2"]);
      expect(page1.total).toBe("3");
      expect(page1.next_after_id).toBe("c2");
      expect(page1.rows.every((r) => r.workspace_name === "svc-alpha")).toBe(true);
      expect(typeof page1.rows[0]!.duration_ms).toBe("string");
      expect(typeof page1.rows[0]!.created_at).toBe("string");
      // Legacy `mcp_calls` has no `connection_id`/`principal` columns -- the
      // encoder must turn their absence into null, not throw.
      expect(page1.rows[0]).toMatchObject({ connection_id: null, principal: null });
      // A healthy page keeps the exact pre-fix-round shape: no report key.
      expect(Object.keys(page1)).toEqual(["rows", "next_after_id", "total"]);

      const page2 = await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-alpha", { after_id: "c2", limit: 2 }));
      expect(page2.rows.map((r) => r.id)).toEqual(["c3"]);
      expect(page2.next_after_id).toBeNull();

      const errorsOnly = await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-alpha", { status: "error" }));
      expect(errorsOnly.rows.map((r) => r.id)).toEqual(["c2"]);
      expect(errorsOnly.total).toBe("1");

      const betaOnly = await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-beta"));
      expect(betaOnly.rows.map((r) => r.id)).toEqual(["cx"]);
      expect(betaOnly.total).toBe("1");
      // Isolation: svc-alpha's page never contains svc-beta's row.
      expect(page1.rows.some((r) => r.id === "cx")).toBe(false);
    });

    /**
     * #103 fix-round BLOCKING finding, writer end: `logCall` stored
     * `session_name` raw, so a value the reader's `storedName` rejects (empty,
     * or over 256 UTF-8 bytes) became a row nobody could list. The writer now
     * records only what the reader can encode: anything else is null, flagged
     * in the wrapper-owned `h_metadata.invalid_fields`.
     */
    test("logCall records an unencodable session_name/peer_name as null plus a flag, never raw", async () => {
      const cases = [
        { session_name: "", peer_name: null, flagged: ["session_name"] },
        { session_name: "ก".repeat(90), peer_name: null, flagged: ["session_name"] }, // 270 UTF-8 bytes
        { session_name: "ok-session", peer_name: "x".repeat(257), flagged: ["peer_name"] },
        { session_name: "ok-session", peer_name: "peer-1", flagged: null },
      ];
      const failuresBefore = fx.calls.auditFailureCount();
      for (const [index, item] of cases.entries()) {
        await fx.calls.logCall({
          tool: `norm-${index}`,
          input: { session_name: item.session_name },
          status: "ok",
          result: null,
          duration_ms: 1,
          workspace_name: "svc-norm",
          session_name: item.session_name,
          peer_name: item.peer_name,
        });
      }
      expect(fx.calls.auditFailureCount()).toBe(failuresBefore);

      const raw = (await (await fx.opsConnection.openTable("mcp_calls"))
        .query()
        .where(`workspace_name = 'svc-norm'`)
        .toArray()) as Record<string, unknown>[];
      const byTool = new Map(raw.map((row) => [row.tool as string, row]));
      for (const [index, item] of cases.entries()) {
        const row = byTool.get(`norm-${index}`)!;
        const meta = JSON.parse(row.h_metadata as string);
        if (item.flagged === null) {
          expect(row).toMatchObject({ session_name: "ok-session", peer_name: "peer-1" });
          expect(meta.invalid_fields).toBeUndefined();
        } else {
          expect(meta.invalid_fields).toEqual(item.flagged);
          for (const field of item.flagged) expect(row[field]).toBeNull();
        }
      }

      // And every one of them is LISTABLE -- the whole point.
      const page = await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-norm"));
      expect(page.total).toBe("4");
      expect(page.rows).toHaveLength(4);
      expect((page as Record<string, unknown>).unreadable).toBeUndefined();
    });

    /**
     * #103 fix-round BLOCKING finding, reader end: rows the PRE-fix writer
     * already stored raw still exist in real `ARRA_DATA_DIR`s. One of them
     * used to turn the whole workspace's listing into `integrity_failure`,
     * and keyset paging could never step past it -- every later row became
     * invisible. It is now withheld from `rows` and REPORTED by id.
     */
    test("a stored row the codec rejects is withheld and reported by id; every page still answers and paging walks past it", async () => {
      const table = await fx.opsConnection.openTable("mcp_calls");
      await table.add([
        callRow("p1", "svc-poison", 100, { session_name: "fine" }),
        callRow("p2", "svc-poison", 200, { session_name: "" }),
        callRow("p3", "svc-poison", 300, { session_name: "ก".repeat(90) }),
        callRow("p4", "svc-poison", 400),
      ]);

      const whole = (await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-poison"))) as Record<string, any>;
      expect(whole.rows.map((r: any) => r.id)).toEqual(["p1", "p4"]);
      expect(whole.unreadable).toEqual([
        { id: "p2", reason: "unencodable" },
        { id: "p3", reason: "unencodable" },
      ]);
      // `total` counts what is STORED, so rows + unreadable add up to it.
      expect(whole.total).toBe("4");

      const seen: string[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const page = (await fx.opsListMcpCalls(fx.mcpCallsRequest("svc-poison", { limit: 1, after_id: after }))) as Record<string, any>;
        seen.push(...page.rows.map((r: any) => r.id), ...(page.unreadable ?? []).map((u: any) => u.id));
        after = page.next_after_id;
        if (after === null) break;
      }
      expect(seen).toEqual(["p1", "p2", "p3", "p4"]);
    });
  });

  describe("service level: listConnections reads the operations root directly", () => {
    test("folds one row per (workspace, method, principal, label), truncates the label, isolates by workspace", async () => {
      const fold = (workspace: string, principal: string, label: string, tool: string | null) =>
        fx.connections.foldConnection({ workspace_name: workspace, method: "mcp", principal, label, tool });
      await fold("svc-alpha", "cred-x", "client/1.0", "recall");
      await fold("svc-alpha", "cred-x", "client/1.0", "recall");
      await fold("svc-alpha", "cred-x", "client/1.0", null);
      await fold("svc-alpha", "cred-y", "other/2.0", "remember");
      await fold("svc-beta", "cred-x", "client/1.0", "recall");
      const longLabel = "L".repeat(2500);
      await fold("svc-alpha", "cred-trunc", longLabel, "recall");

      const alpha = await fx.opsListConnections(fx.connectionsRequest("svc-alpha"));
      expect(alpha.total).toBe("3");
      expect(alpha.rows.every((r) => r.workspace_name === "svc-alpha")).toBe(true);

      const credX = alpha.rows.find((r) => r.principal === "cred-x");
      expect(credX).toMatchObject({ workspace_name: "svc-alpha", method: "mcp", label: "client/1.0", requests: "3", tool_calls: "2" });
      const firstSeen = Date.parse(credX!.first_seen as string);
      const lastSeen = Date.parse(credX!.last_seen as string);
      expect(Number.isNaN(firstSeen)).toBe(false);
      expect(Number.isNaN(lastSeen)).toBe(false);
      expect(firstSeen).toBeLessThanOrEqual(lastSeen);

      const truncated = alpha.rows.find((r) => r.principal === "cred-trunc");
      expect(truncated!.label).toBe(`${longLabel.slice(0, 2000)}…[2500 chars]`);

      // Isolation: svc-beta's own row for the SAME principal/label is a
      // DIFFERENT id and never appears in svc-alpha's page.
      const beta = await fx.opsListConnections(fx.connectionsRequest("svc-beta"));
      expect(beta.total).toBe("1");
      expect(beta.rows.every((r) => r.workspace_name === "svc-beta")).toBe(true);
      expect(alpha.rows.some((r) => r.id === beta.rows[0]!.id)).toBe(false);
    });

    /**
     * #102 fix-round blocking finding (verifier, 2026-09-26): `foldConnection`
     * launched fire-and-forget for the SAME id, with no in-process
     * serialization, wrote several rows sharing one id -- measured, before the
     * fix, `Promise.all` of 5 concurrent folds gave 5 rows, all id-equal,
     * `requests` all `1` (every fold read "no prior row").
     */
    test("concurrent folds for the SAME id never create duplicate rows or an unreadable page", async () => {
      const event = { workspace_name: "svc-concurrent", method: "mcp", principal: "cred-race", label: "racer/1.0", tool: "recall" };
      await Promise.all(Array.from({ length: 8 }, () => fx.connections.foldConnection(event)));

      const raw = (await (await fx.opsConnection.openTable("connections"))
        .query()
        .where(`workspace_name = 'svc-concurrent'`)
        .toArray()) as Record<string, unknown>[];
      expect(raw.length).toBe(1);

      const page = await fx.opsListConnections(fx.connectionsRequest("svc-concurrent"));
      expect(page.total).toBe("1");
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ workspace_name: "svc-concurrent", principal: "cred-race", requests: "8", tool_calls: "8" });
    });

    /**
     * Upgrade risk (verifier, nonblocking): a store the #106-#108 writer
     * already used can hold duplicate-id rows, keyed on `principal_id`. No
     * post-R5 fold ever touches those ids, so they never heal -- and the
     * reader used to refuse the WHOLE workspace over them. Now the listing
     * answers and names the id it could not resolve.
     */
    test("legacy duplicate-id rows are reported, never deny listConnections for the workspace", async () => {
      const table = await fx.opsConnection.openTable("connections");
      const legacy = foldIdFor("svc-upgrade", "unknown", "person-old", "client/1.0");
      await table.add([
        connectionRow(legacy, "svc-upgrade", "person-old", 1),
        connectionRow(legacy, "svc-upgrade", "person-old", 1),
        connectionRow(foldIdFor("svc-upgrade", "unknown", "cred-new", "client/1.0"), "svc-upgrade", "cred-new", 4),
      ]);

      const page = (await fx.opsListConnections(fx.connectionsRequest("svc-upgrade"))) as Record<string, any>;
      expect(page.rows.map((r: any) => r.principal)).toEqual(["cred-new"]);
      expect(page.unreadable).toEqual([{ id: legacy, reason: "duplicate_id" }]);
      expect(page.total).toBe("3");
    });

    /**
     * Healing: the per-id queue only serializes ONE process. When a second
     * writer did leave duplicates for a key the fold still uses, the next
     * fold for that key must SUM them (and keep the earliest `first_seen`)
     * rather than read one arbitrary row and delete the rest's counts.
     */
    test("the next fold for a duplicated key sums the duplicates into one row", async () => {
      const table = await fx.opsConnection.openTable("connections");
      const id = foldIdFor("svc-heal", "mcp", "cred-heal", "client/1.0");
      await table.add([
        connectionRow(id, "svc-heal", "cred-heal", 2, { method: "mcp", first_seen: 1_790_000_000_000 }),
        connectionRow(id, "svc-heal", "cred-heal", 3, { method: "mcp", first_seen: 1_780_000_000_000 }),
      ]);

      await fx.connections.foldConnection({ workspace_name: "svc-heal", method: "mcp", principal: "cred-heal", label: "client/1.0", tool: "recall" });

      const page = await fx.opsListConnections(fx.connectionsRequest("svc-heal"));
      expect((page as Record<string, unknown>).unreadable).toBeUndefined();
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ requests: "6", tool_calls: "6" });
      expect(Date.parse(page.rows[0]!.first_seen as string)).toBe(1_780_000_000_000);
    });

    /**
     * Nonblocking finding: the key computation ran OUTSIDE the fold's own
     * try/catch, so a throw there rejected the fire-and-forget promise
     * (swallowed by `composition.ts`'s `.catch`) and was never counted.
     */
    test("a fold whose key cannot be computed is counted as a failure, never an unhandled rejection", async () => {
      const before = fx.connections.connectionFoldFailureCount();
      const bad = { workspace_name: "svc-bad", method: "mcp", principal: "cred-bad", label: undefined as unknown as string, tool: null };
      await expect(fx.connections.foldConnection(bad)).resolves.toBeUndefined();
      expect(fx.connections.connectionFoldFailureCount()).toBe(before + 1);
    });
  });
}
