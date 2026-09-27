import { type ConclusionItem, type ContextBudget, type ContextFreshness, MAX_CONTEXT_WIRE_BYTES } from "./chat";
import { estimateTokens } from "./chat.estimateTokens";
import { type RequestAuthority, requireMessageReadAuthority } from "./context";
import { PublicationError } from "./errors";
import { contextFreshness } from "./service.contextFreshness";
import { requireCurrentMembership } from "./service.requireCurrentMembership";
import { requirePerspectivePeer } from "./service.requirePerspectivePeer";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectConclusions } from "./service.selectConclusions";
import { parseGetRepresentation } from "./chat.parseGetRepresentation";
import { type DatasetAdapter } from "./service.types";

export type RepresentationResult = {
  workspace_name: string;
  observer_peer_name: string;
  subject_peer_name: string;
  conclusions: ConclusionItem[];
  summary: ConclusionItem | null;
  /** "full" only when nothing eligible was withheld, bounded or budgeted. */
  coverage: "full" | "partial";
  budget: ContextBudget;
  freshness: ContextFreshness;
};

/**
 * D3b (DESIGN.md §12 "Peer representation without more core tables"): the
 * scoped `observer -> subject` view of CURRENT conclusions in ONE workspace.
 * Computed on every read from the same eligibility rule `getContext` uses
 * (`selectConclusions`); no table, no cache, no model, no write.
 *
 * The read boundary is #87 / R3's, the same as `listMessages`: no requester
 * is the audit:read operator view; a named requester must sit inside the
 * grant's peer binding and exist, and then sees a session-scoped conclusion
 * or source only while it is a CURRENT member of that session. Observer and
 * subject are lookup targets: they must exist, and they grant nothing.
 *
 * The scope is the WORKSPACE as the requester may read it: session-less
 * conclusions plus those of sessions it currently belongs to. A conclusion
 * in any other session is outside that scope and raises no flag -- flagging
 * it per observer/subject pair would tell the caller that a hidden view of
 * that pair exists. A protected SOURCE of a returned conclusion is still the
 * coarse `sources_incomplete` flag (DESIGN.md §12).
 *
 * `requestTimeMs` is the eligibility `as_of`, supplied by the registry; the
 * fallback is for in-process harnesses only (see `service.getContext.ts`).
 */
export async function getRepresentation(
  reader: DatasetAdapter,
  requestBytes: Uint8Array,
  authority: RequestAuthority,
  requestTimeMs?: number,
): Promise<RepresentationResult> {
  const request = parseGetRepresentation(requestBytes);
  // Storage-free first, so a refused caller learns nothing.
  requireMessageReadAuthority(request.requester_peer_name, authority);
  const asOf = requestTimeMs ?? Date.now();
  await requireWorkspace(reader, request.workspace_name);
  await requirePerspectivePeer(reader, request.workspace_name, request.requester_peer_name, "/requester_peer_name");
  await requirePerspectivePeer(reader, request.workspace_name, request.observer_peer_name, "/observer_peer_name");
  await requirePerspectivePeer(reader, request.workspace_name, request.subject_peer_name, "/subject_peer_name");

  const requester = request.requester_peer_name;
  const visibility = new Map<string, boolean>();
  const canSeeSession = async (sessionName: string): Promise<boolean> => {
    if (requester === null) return true; // the operator view
    const known = visibility.get(sessionName);
    if (known !== undefined) return known;
    let allowed = true;
    try {
      await requireCurrentMembership(reader, request.workspace_name, sessionName, requester, "/requester_peer_name");
    } catch (error) {
      if (!(error instanceof PublicationError) || error.code !== "invalid_reference") throw error;
      allowed = false;
    }
    visibility.set(sessionName, allowed);
    return allowed;
  };

  const selection = await selectConclusions(reader, {
    workspace: request.workspace_name,
    observer: request.observer_peer_name,
    subject: request.subject_peer_name,
    asOf,
    maxItems: request.max_items,
    byteBudget: MAX_CONTEXT_WIRE_BYTES - 2,
    inScope: canSeeSession,
    canSeeSession,
  });
  const used = 2 + selection.usedBytes;
  return {
    workspace_name: request.workspace_name,
    observer_peer_name: request.observer_peer_name,
    subject_peer_name: request.subject_peer_name,
    conclusions: selection.conclusions,
    summary: selection.summary,
    coverage: selection.incomplete || selection.truncated ? "partial" : "full",
    budget: {
      max_items: request.max_items,
      max_wire_bytes: MAX_CONTEXT_WIRE_BYTES,
      used_wire_bytes: used,
      tokenizer: null,
      token_count_kind: "estimate",
      estimate_heuristic: "ceil(utf8_bytes/4)",
      estimated_tokens: estimateTokens(used),
      truncated: selection.truncated,
    },
    freshness: await contextFreshness(reader, asOf),
  };
}
