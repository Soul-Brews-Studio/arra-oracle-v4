import type { StoreDependencies } from "./auth/service.createOperationService";

/**
 * The ONE audit sink (§4, DECISIONS.md R5): an `mcp_calls` row plus the
 * `connections` fold, both in the operations root. MCP reaches it through
 * `composeService` (`appendAudit`); `POST /api/knowledge/:bank/:method` (#31,
 * R8) through `buildApp`. One sink, so HTTP, MCP and the CLI land in the same
 * tables with the same redaction and attribution.
 */
export async function composeAuditSink(): Promise<StoreDependencies["logCall"]> {
  const calls = await import("./mcp/calls");
  const connections = await import("./mcp/connections");
  return (record) => {
    const entry = record as {
      tool: string;
      input: unknown;
      status: "ok" | "error";
      result: unknown;
      duration_ms: number;
      workspace_name: string;
      session_name?: string | null;
      client_label?: string | null;
      peer_name?: string | null;
      requested_as?: string | null;
      transport?: string | null;
      remote_ip?: string | null;
      auth: { principal_id: string; credential_id: string; policy_version: string };
    };
    // #102: the same admitted request feeds BOTH operations tables. The log
    // is per-call and append-only; the fold is per-caller and bounded by the
    // caller population. Fired without await and with its own catch so a
    // dashboard-only table can never delay or fail the request it describes
    // -- `foldConnection` is already best-effort internally, this is the
    // second belt.
    void connections
      .foldConnection({
        workspace_name: entry.workspace_name,
        // DECISIONS.md R19: SPEC §7.2 defines `method` as the AUTH method
        // (bearer | oauth | owner-session), not the transport. Every request
        // that reaches this fold was admitted by an arra-auth/v1 bearer
        // credential (auth/http.ts); oauth and owner sessions do not exist yet.
        method: "bearer",
        // DECISIONS.md R5: `principal` is the CREDENTIAL id, matching
        // SPEC §7.2 ("token id or oauth client_id") -- never `principal_id`,
        // which names the PERSON/service the credential belongs to, not the
        // credential itself. One principal can hold several credentials,
        // each a distinct caller from this table's point of view.
        principal: entry.auth.credential_id,
        label: entry.client_label?.trim() ? entry.client_label : "unlabelled",
        user_agent: entry.client_label ?? null,
        // DECISIONS.md R5: stays null. No caller of `logCall` ever sets
        // `entry.remote_ip` today (`appendAudit` in `auth/service.createOperationService.ts` does
        // not collect it) -- capturing it is a privacy decision left for a
        // later slice, not silently done here.
        remote_ip: entry.remote_ip ?? null,
        tool: entry.tool,
      })
      .catch(() => {});
    return calls.logCall({
      tool: entry.tool,
      input: entry.input,
      status: entry.status,
      result: entry.result,
      duration_ms: entry.duration_ms,
      workspace_name: entry.workspace_name,
      // peer_name stays a DOMAIN field: the principal never populates it.
      // It carries only the speaker the connection ASSERTED (X-Arra-Peer,
      // R18 A7), which the service already checked against the grant.
      peer_name: entry.peer_name ?? null,
      requested_as: entry.requested_as ?? null,
      session_name: entry.session_name ?? null,
      client_label: entry.client_label ?? null,
      auth: entry.auth,
    });
  };
}
