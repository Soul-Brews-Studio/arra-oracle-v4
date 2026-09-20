/**
 * Scope-aware replay classification — candidate v1.
 *
 * Source identity scope is (workspace_name, source_namespace, source_message_id);
 * revision operation scope is (workspace_name, "node_revision", operation_id).
 * These are tuples compared component-wise, never delimiter-joined strings.
 * A helper given an existing record CHECKS the scope itself rather than
 * trusting that the caller queried correctly: a wrong-scope record is a
 * `scope_mismatch` error, not "idempotent", even when digests happen to agree.
 *
 * `source_namespace` is an opaque nonempty valid-Unicode string compared by
 * exact bytes — no trim, casefold, URI equivalence or split-on-slash grammar.
 *
 * No database-backed uniqueness, publication, or service ordering is proven.
 * Contract: app/docs/contracts/revision-evidence-v1.md §6.
 */

import { fail } from "./errors";
import { type JcsObject, type JcsValue } from "./jcs";
import { requireClosedObject, requireNanoid21, requireNonemptyString, requireSha256Hex, type Tokens } from "./common";

export type ReplayOutcome = "new" | "idempotent" | "conflict";
export type ReplayResult = { outcome: ReplayOutcome; original_id: string | null };

const SOURCE_INCOMING = ["workspace_name", "source_namespace", "source_message_id", "content_digest"] as const;
const SOURCE_EXISTING = [...SOURCE_INCOMING, "message_public_id"] as const;
const REVISION_INCOMING = ["workspace_name", "operation_id", "content_digest"] as const;
const REVISION_EXISTING = [...REVISION_INCOMING, "revision_id"] as const;

function classify(scopeKeys: readonly string[], incoming: JcsObject, existing: JcsObject | null, idKey: string, tokens: Tokens): ReplayResult {
  const incomingDigest = incoming.get("content_digest") as string;
  if (existing === null) return { outcome: "new", original_id: null };
  for (const k of scopeKeys) {
    if (incoming.get(k) !== existing.get(k)) {
      fail("scope_mismatch", [...tokens, "existing", k], `existing record is outside the incoming ${k} scope`);
    }
  }
  const existingDigest = existing.get("content_digest") as string;
  if (existingDigest === incomingDigest) return { outcome: "idempotent", original_id: existing.get(idKey) as string };
  return { outcome: "conflict", original_id: null };
}

export function sourceReplayOp(incoming: JcsValue, existing: JcsValue, tokens: Tokens = []): ReplayResult {
  const inc = requireClosedObject(incoming, SOURCE_INCOMING, [...tokens, "incoming"]);
  requireNonemptyString(inc.get("workspace_name")!, [...tokens, "incoming", "workspace_name"]);
  requireNonemptyString(inc.get("source_namespace")!, [...tokens, "incoming", "source_namespace"]);
  requireNonemptyString(inc.get("source_message_id")!, [...tokens, "incoming", "source_message_id"]);
  requireSha256Hex(inc.get("content_digest")!, [...tokens, "incoming", "content_digest"]);
  let ex: JcsObject | null = null;
  if (existing !== null) {
    ex = requireClosedObject(existing, SOURCE_EXISTING, [...tokens, "existing"]);
    requireNonemptyString(ex.get("workspace_name")!, [...tokens, "existing", "workspace_name"]);
    requireNonemptyString(ex.get("source_namespace")!, [...tokens, "existing", "source_namespace"]);
    requireNonemptyString(ex.get("source_message_id")!, [...tokens, "existing", "source_message_id"]);
    requireSha256Hex(ex.get("content_digest")!, [...tokens, "existing", "content_digest"]);
    requireNanoid21(ex.get("message_public_id")!, [...tokens, "existing", "message_public_id"]);
  }
  return classify(["workspace_name", "source_namespace", "source_message_id"], inc, ex, "message_public_id", tokens);
}

export function revisionReplayOp(incoming: JcsValue, existing: JcsValue, tokens: Tokens = []): ReplayResult {
  const inc = requireClosedObject(incoming, REVISION_INCOMING, [...tokens, "incoming"]);
  requireNonemptyString(inc.get("workspace_name")!, [...tokens, "incoming", "workspace_name"]);
  requireNonemptyString(inc.get("operation_id")!, [...tokens, "incoming", "operation_id"]);
  requireSha256Hex(inc.get("content_digest")!, [...tokens, "incoming", "content_digest"]);
  let ex: JcsObject | null = null;
  if (existing !== null) {
    ex = requireClosedObject(existing, REVISION_EXISTING, [...tokens, "existing"]);
    requireNonemptyString(ex.get("workspace_name")!, [...tokens, "existing", "workspace_name"]);
    requireNonemptyString(ex.get("operation_id")!, [...tokens, "existing", "operation_id"]);
    requireSha256Hex(ex.get("content_digest")!, [...tokens, "existing", "content_digest"]);
    requireNanoid21(ex.get("revision_id")!, [...tokens, "existing", "revision_id"]);
  }
  return classify(["workspace_name", "operation_id"], inc, ex, "revision_id", tokens);
}
