import { CANONICAL_VERSION, SCHEMA_VERSION } from "../contracts/revision-v1";
import { type PlannedMemory, type PlannedWorkspace } from "./plan.types";
import { requestBytes } from "./requestBytes";

/**
 * One legacy memory as a `publishRevision` request: the node's FIRST revision.
 *
 *   title  <- memories.name        body <- memories.content, body_format "text"
 *   author, observer               NULL (legacy writer kept as legacy_peer_name,
 *                                  attribution_unresolved: true, never inferred)
 *   terms  <- exactly one reserved `type` term (R11), then the R11 legacy_type
 *             tag when the legacy string was not reserved, then memory_terms
 *   links  <- one `derived_from` trace link per legacy distilled_to, as a
 *             passive `locator_only` locator; captured_at stays NULL because
 *             the legacy row never captured anything (R17: distilled_at lives
 *             in internal_metadata)
 *
 * The request is RAW input: the kernel's governed codec validates, normalizes
 * and digests it. Nothing here canonicalizes.
 */
export function buildRevisionRequest(workspace: PlannedWorkspace, memory: PlannedMemory): Uint8Array {
  const typeTermId = workspace.seed.type.terms[memory.type_term];
  if (typeTermId === undefined) throw new Error(`plan names unknown type term ${memory.type_term}`);
  const terms: Array<Record<string, unknown>> = [{
    term_id: typeTermId,
    vocabulary_id: workspace.seed.type.vocabulary_id,
    vocabulary_name_snapshot: "type",
    term_name_snapshot: memory.type_term,
    label_snapshot: null,
  }];
  if (memory.legacy_type_tag !== null) {
    const vocabulary = workspace.legacy_type_vocabulary;
    const tag = workspace.legacy_type_terms.find((term) => term.name === memory.legacy_type_tag);
    if (vocabulary === null || tag === undefined) throw new Error(`plan lacks legacy_type term ${memory.legacy_type_tag}`);
    terms.push({
      term_id: tag.term_id,
      vocabulary_id: vocabulary.vocabulary_id,
      vocabulary_name_snapshot: vocabulary.name,
      term_name_snapshot: tag.name,
      label_snapshot: null,
    });
  }
  for (const term of memory.terms) {
    terms.push({
      term_id: term.term_id,
      vocabulary_id: term.vocabulary_id,
      vocabulary_name_snapshot: term.vocabulary_name,
      term_name_snapshot: term.term_name,
      label_snapshot: null,
    });
  }
  const links = memory.links.map((link, position) => ({
    position: String(position),
    relation: "derived_from",
    target_kind: "trace",
    target: { trace_id: link.trace_id },
    excerpt: null,
    content_hash: null,
    captured_at: null,
    capture_status: "locator_only",
    note: null,
  }));

  return requestBytes({
    operation_id: memory.operation_id,
    content: {
      workspace_name: workspace.workspace_name,
      node_id: memory.node_id,
      base_revision_id: null,
      title: memory.title,
      body: memory.body,
      body_format: "text",
      fields: "{}",
      author_peer_name: null,
      observer_peer_name: null,
      subject_peer_name: memory.subject_peer_name,
      session_name: memory.session_name,
      is_active: memory.is_active,
      valid_from: memory.valid_from,
      valid_to: memory.valid_to,
      change_reason: null,
      schema_version: SCHEMA_VERSION,
      canonical_version: CANONICAL_VERSION,
      term_snapshot_json: JSON.stringify(terms.map((term, position) => ({ ...term, position: String(position) }))),
      link_snapshot_json: JSON.stringify(links),
      h_metadata: memory.h_metadata,
      internal_metadata: JSON.stringify(memory.internal_metadata),
    },
  });
}
