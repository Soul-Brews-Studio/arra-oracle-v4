import { KNOWLEDGE_METHODS, type KnowledgeBundle, type RequestAuthority } from "../knowledge/registry";
import type { KnowledgeAccess } from "../knowledge/transport";
import { requireBoundPeers } from "../knowledge/transport.requireBoundPeers";

/**
 * Call one registry method over MCP, from already-encoded request bytes. The
 * ONE path both `kb_<method>` tools and the v3 adapter's `kb()` take
 * (docs/overnight/V3-PARITY.md §3 A1), so neither can skip the peer binding
 * or the ephemeral-writer discipline.
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
  if (access === null) throw new Error("knowledge transport is not configured");
  // #87 / R3: the same peer-binding refusal as HTTP, before any writer opens;
  // it throws the governed `forbidden` envelope, carried out unchanged.
  requireBoundPeers(method, bytes, authority);
  // Same gate discipline as the HTTP transport (`knowledge/transport.ts`'s
  // `handleKnowledgeRequest`): an `ephemeralWrite` method (currently only
  // `answerChat`) must never share the process-lifetime cached writer, or
  // `kb_answerChat` would seize the exclusive dataset gate on its first MCP
  // call and hold it for the rest of the process -- a call that persists
  // nothing and, at this deployment, cannot even succeed.
  if (entry.ephemeralWrite === true) {
    if (access.getEphemeralWriter === undefined) {
      throw new Error("knowledge transport cannot open an ephemeral writer");
    }
    const opened = await access.getEphemeralWriter();
    try {
      return await entry.call(opened, bytes, authority);
    } finally {
      await opened.close().catch(() => undefined);
    }
  }
  return entry.call(await (bundle ?? (() => access.getBundle(entry.action)))(), bytes, authority);
}
