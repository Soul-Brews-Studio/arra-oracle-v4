import { CANONICAL_VERSION, SCHEMA_VERSION } from "../../contracts/revision-v1";
import { CompatError } from "./compat-error";
import type { V3ToolContext } from "./handlers";
import { derivedId } from "./ids.derivedId";
import { randomId } from "./ids.randomId";
import { termSnapshot, type WantedTerms } from "./taxonomy.termSnapshot";

export type PublishInput = {
  title: string;
  body: string;
  fields: Record<string, unknown>;
  terms: WantedTerms;
  links: Record<string, unknown>[];
  author: string | null;
  sessionName: string | null;
  changeReason: string | null;
  idempotencyKey: unknown;
  /** V3 slice, K5: reconcile `revision_links`/`node_revision_terms` for this
   *  ONE revision right after the publish, so a reader that depends on the
   *  MATERIALIZED projection (K5's `listTraces.derived_from_count`) sees it
   *  immediately, the same way indexing below makes it searchable at once.
   *  Default false: only `oracle_trace_distill` writes a link a later reader
   *  needs this fast; `oracle_learn`/`oracle_handoff`/`oracle_research_note`
   *  write no links at all, so reconciling for them would be a no-op cost. */
  reconcile?: boolean;
};

export type Published = {
  node_id: string;
  revision_id: string;
  outcome: string;
  embedding: "enqueued" | "failed";
  embeddingError?: string;
};

/**
 * Publish one new node through `publishRevision`, then index it
 * (V3-PARITY.md §4.3 oracle_learn). The 21-key revision-v1 envelope is
 * filled here and nowhere else in the adapter.
 *
 * Ids are random unless the caller passed `idempotency_key` (A8), which
 * derives both the node id and the operation id, so a client retry replays as
 * `idempotent`. Indexing uses the server's configured chunker and embedding
 * profile, never the caller's; if it fails the publish still stands, the
 * answer says `embedding:"failed"`, and `reconcileSearchChunks` lists the
 * revision as missing -- v3's rule that embedding never blocks the write.
 */
export async function publish(context: V3ToolContext, input: PublishInput): Promise<Published> {
  const { bank, kb, tool } = context;
  let nodeId = randomId();
  let operationId = `v3:${tool}:${randomId()}`;
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey === "") {
      throw new CompatError(tool, "unsupported_argument", "Invalid input at /idempotency_key", "idempotency_key must be a nonempty string", { path: "/idempotency_key" });
    }
    nodeId = derivedId(bank, "node", tool, input.idempotencyKey);
    operationId = `v3:${tool}:${derivedId(bank, "operation", tool, input.idempotencyKey)}`;
  }

  const content = {
    node_id: nodeId,
    base_revision_id: null,
    title: input.title,
    body: input.body,
    body_format: "markdown",
    fields: JSON.stringify(input.fields),
    author_peer_name: input.author,
    observer_peer_name: null,
    subject_peer_name: null,
    session_name: input.sessionName,
    is_active: true,
    valid_from: null,
    valid_to: null,
    change_reason: input.changeReason,
    schema_version: SCHEMA_VERSION,
    canonical_version: CANONICAL_VERSION,
    term_snapshot_json: await termSnapshot(kb, bank, tool, input.terms),
    link_snapshot_json: JSON.stringify(input.links.map((link, position) => ({ position: String(position), ...link }))),
    h_metadata: null,
    internal_metadata: JSON.stringify({ created_by: `${tool}/arra-v3-compat/1` }),
  };

  let outcome: { outcome: string; node_id?: string; revision_id?: string; reason?: string };
  try {
    outcome = (await kb("publishRevision", { operation_id: operationId, content })) as typeof outcome;
  } catch (error) {
    const e = error as { code?: unknown; path?: unknown; toJSON?: () => unknown };
    // Every snapshot this adapter builds names one type, at most one horizon
    // and open vocabularies, so the kernel's remaining term-policy refusal is
    // a required vocabulary the tool has no term for.
    if (e.code === "invalid_request" && e.path === "/content/term_snapshot_json" && typeof e.toJSON === "function") {
      throw new CompatError(tool, "semantic_refusal", "this bank requires a vocabulary that this v3 tool cannot fill",
        "a required vocabulary (or a term rule) of this workspace is not satisfiable through the v3 adapter; publish through kb_publishRevision", { v4Error: e.toJSON() });
    }
    throw error;
  }
  if (outcome.outcome === "conflict") {
    throw new CompatError(tool, "semantic_refusal", `write refused: ${outcome.reason}`,
      outcome.reason === "operation_digest" ? "this idempotency_key was already used for different content" : `v4 publish conflict: ${outcome.reason}`,
      { path: outcome.reason === "operation_digest" ? "/idempotency_key" : "" });
  }

  const published: Published = { node_id: outcome.node_id!, revision_id: outcome.revision_id!, outcome: outcome.outcome, embedding: "enqueued" };
  try {
    await kb("indexRevisionChunks", { node_id: published.node_id, revision_id: published.revision_id, ...context.indexProfile });
  } catch (error) {
    published.embedding = "failed";
    published.embeddingError = error instanceof Error ? error.message : String(error);
  }
  if (input.reconcile === true) {
    // Best-effort, like indexing above: a reconciliation fault never
    // unwinds an already-accepted publish. Unlike indexing, no caller-visible
    // field reports failure here -- `reconcileRevisionAssociations` is
    // idempotent and safe to retry later (`kb_reconcileRevisionAssociations`
    // or a future backfill), so there is nothing for this adapter to surface
    // that a retry would not equally fix.
    await kb("reconcileRevisionAssociations", { node_id: published.node_id, revision_id: published.revision_id }).catch(() => {});
  }
  return published;
}
