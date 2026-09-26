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
};

export type Published = {
  node_id: string;
  revision_id: string;
  outcome: string;
  embedding: "enqueued" | "failed";
  embeddingError?: string;
  /** Set only when the association reconcile below throws. Absent means
   *  reconciled -- there is no separate "reconciled" literal to check. */
  associationsError?: string;
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
 *
 * `reconcileRevisionAssociations` runs here too, right after `publishRevision`
 * and before indexing, for the same reason `indexRevisionChunks` runs here: a
 * v3 client has no tool that can call it directly (it is `content:write` and
 * no `V3_CATALOGUE` entry exposes it), so if this adapter did not call it,
 * `node_revision_terms` would never be filled for a v3-created node and K6
 * `listTermUsage` (`oracle_concepts`, `oracle_stats.unique_concepts`) would
 * answer zero for every one of them, forever, with nothing on the wire to say
 * so -- the exact "silently miss...and present that partial set as if it
 * were complete" trap `service.listNodes.ts` already warns about for a
 * different table. Like indexing, a reconcile failure does not fail the
 * publish (the node is already written and readable; the answer says
 * `associationsError`, and every caller of `publish()` turns that into a
 * `compat_warnings` entry, so the gap is disclosed, never silent). A client
 * retry with the same `idempotency_key` re-attempts both this call and
 * indexing, since `publishRevision`'s `idempotent` outcome still falls
 * through to them below.
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
    await kb("reconcileRevisionAssociations", { node_id: published.node_id, revision_id: published.revision_id });
  } catch (error) {
    published.associationsError = error instanceof Error ? error.message : String(error);
  }
  try {
    await kb("indexRevisionChunks", { node_id: published.node_id, revision_id: published.revision_id, ...context.indexProfile });
  } catch (error) {
    published.embedding = "failed";
    published.embeddingError = error instanceof Error ? error.message : String(error);
  }
  return published;
}
