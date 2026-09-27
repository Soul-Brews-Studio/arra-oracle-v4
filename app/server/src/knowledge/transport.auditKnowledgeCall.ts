// #31 / R8 audit parity (fix round 2026-09-27): an ADMITTED
// `POST /api/knowledge/:bank/:method` lands in the same audit sink as MCP
// `tools/call` (`auth/service.ts` `appendAudit`), through the same composed
// writer (`composition.ts` `composeAuditSink`: one `mcp_calls` row plus the
// `connections` fold, DECISIONS.md R5). The CLI's `kb <method>` leg forwards
// to this route, so it is audited here too.
//
// The row is built to be indistinguishable from the one an MCP `kb_<method>`
// call writes, except for the transport user agent: the same tool name, the
// same `{ payload }` input the MCP arguments carry (so `mcp/calls.ts` redacts
// it identically), the same result or governed envelope text, and a null
// `session_name`, which is what the MCP path records for every `kb_*` call.

import { auditErrorText } from "../auth/service.auditErrorText";

/** The composed sink; absent in-process fixtures audit nothing. */
export type KnowledgeAuditSink = (record: Record<string, unknown>) => Promise<void>;

export type KnowledgeAuditCall = {
  readonly method: string;
  readonly workspace: string;
  /** The ORIGINAL request bytes, already accepted by the governed parser. */
  readonly bytes: Uint8Array;
  readonly auth: { principal_id: string; credential_id: string; policy_version: string };
  readonly userAgent: string | null;
  readonly startedMs: number;
};

export async function auditKnowledgeCall(
  sink: KnowledgeAuditSink | undefined,
  call: KnowledgeAuditCall,
  outcome: { readonly status: "ok"; readonly value: unknown } | { readonly status: "error"; readonly error: unknown },
): Promise<void> {
  if (sink === undefined) return;
  let payload: unknown;
  try {
    // Safe to re-read: the strict parser already accepted these bytes, and
    // this copy is only ever audit input, never what the kernel runs on.
    payload = JSON.parse(new TextDecoder().decode(call.bytes));
  } catch {
    payload = null;
  }
  await sink({
    tool: `kb_${call.method}`,
    input: { payload },
    status: outcome.status,
    result: outcome.status === "ok" ? outcome.value : auditErrorText(outcome.error),
    duration_ms: Date.now() - call.startedMs,
    workspace_name: call.workspace,
    session_name: null,
    client_label: call.userAgent?.trim() ? call.userAgent : null,
    peer_name: null,
    requested_as: null,
    auth: call.auth,
  });
}
