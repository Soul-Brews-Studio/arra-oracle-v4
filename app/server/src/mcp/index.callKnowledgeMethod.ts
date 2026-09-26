import { KNOWLEDGE_METHODS, type KnowledgeBundle, type RequestAuthority } from "../knowledge/registry";
import type { KnowledgeAccess } from "../knowledge/transport";
import { requireBoundPeers } from "../knowledge/transport.requireBoundPeers";

/**
 * Call one registry method over MCP, from already-encoded request bytes. The
 * ONE path both `kb_<method>` tools and the v3 adapter's `kb()` take
 * (docs/overnight/V3-PARITY.md §3 A1), so neither can skip the peer binding,
 * the operations-root branch or the bundle discipline.
 *
 * `bundle` lets a caller pin one bundle for a whole tool call (the v3
 * adapter opens it for the TOOL's action, so a write tool reads through the
 * same writer it writes with). Absent, the method's own action picks it.
 */
export async function callKnowledgeMethod(
  access: KnowledgeAccess | null,
  method: string,
  bytes: Uint8Array,
  authority: RequestAuthority,
  bundle?: () => Promise<KnowledgeBundle>,
): Promise<unknown> {
  const entry = KNOWLEDGE_METHODS[method];
  if (entry === undefined) throw new Error("unknown tool");
  // #87 / R3: the same peer-binding refusal as HTTP, before any writer opens;
  // it throws the governed `forbidden` envelope, carried out unchanged.
  requireBoundPeers(method, bytes, authority);
  // Operations-root methods (R5) never touch `access` at all -- so
  // `kb_listMcpCalls`/`kb_listConnections` answer even when the knowledge
  // transport is not configured, matching the HTTP branch in
  // `knowledge/transport.ts`'s `handleKnowledgeRequest`.
  if (entry.operations !== undefined) return entry.operations(bytes);
  if (access === null) throw new Error("knowledge transport is not configured");
  // Same bundle discipline as the HTTP transport: the registry's action (or
  // the caller's pinned bundle) picks the bundle. `answerChat` is a READ on
  // the reader's `chat` facade (#32 / R9), so no per-call writer exists any
  // more -- the ephemeral-writer path this helper once carried was removed
  // by the chat slice and reconciled here at the overnight merge.
  return entry.call(await (bundle ?? (() => access.getBundle(entry.action)))(), bytes, authority);
}
