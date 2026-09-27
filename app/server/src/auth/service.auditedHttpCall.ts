/**
 * #31 legacy-audit (2026-09-27): run the post-admission part of one legacy
 * HTTP memory call and audit it as its MCP twin (`runMcp` in `service.ts`).
 *
 * The row matches the twin's: the twin's tool name, `status`, the input in the
 * MCP argument shape, `session_name` read from that input exactly as `runMcp`
 * reads `args.session_name`, the user agent, and the result the caller
 * received (or `auditErrorText` on failure). Timing starts after admission,
 * as on MCP. `peer_name` and `requested_as` stay null: the legacy routes never
 * read `X-Arra-Peer` and have no aliases. Only an ADMITTED call reaches this:
 * `append` needs the context admission minted.
 */

import { auditErrorText } from "./service.auditErrorText";
import type { HttpAudit } from "./service.types";

type AuditEntry = {
  tool: string;
  input: unknown;
  status: "ok" | "error";
  result: unknown;
  duration_ms: number;
  session_name: string | null;
  client_label: string | null;
  peer_name: null;
  requested_as: null;
};

export async function auditedHttpCall<T>(
  append: (entry: AuditEntry) => Promise<void>,
  clock: () => number,
  call: { readonly tool: string; readonly http: HttpAudit; readonly input: () => unknown },
  run: () => Promise<T>,
  present: (value: T) => unknown = (value) => value,
): Promise<T> {
  const started = clock();
  const input = call.http.input === undefined ? call.input() : call.http.input;
  const session = (input as { session_name?: unknown } | null)?.session_name;
  const row = (status: "ok" | "error", result: unknown): AuditEntry => ({
    tool: call.tool,
    input,
    status,
    result,
    duration_ms: clock() - started,
    session_name: typeof session === "string" ? session : null,
    client_label: call.http.userAgent || null,
    peer_name: null,
    requested_as: null,
  });
  let value: T;
  try {
    value = await run();
  } catch (error) {
    await append(row("error", auditErrorText(error)));
    throw error;
  }
  await append(row("ok", present(value)));
  return value;
}
