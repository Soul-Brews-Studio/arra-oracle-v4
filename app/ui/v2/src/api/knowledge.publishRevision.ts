import { newPublicId, type Bank } from "./memory";
import {
  type TaxonomyIds,
  type PublishInput,
  type TermSnapshot,
  SCHEMA_VERSION,
  CANONICAL_VERSION,
} from "./knowledge";
import { call } from "./knowledge.call";

/** Build the term snapshots for a revision: exactly one `type`, plus at most
 *  one `memory_horizon`. Positions are assigned here so the caller never has
 *  to remember that they are decimal strings. */
function termSnapshots(ids: TaxonomyIds, input: PublishInput): TermSnapshot[] {
  const terms: TermSnapshot[] = [
    {
      term_id: ids.type.terms[input.type_term],
      vocabulary_id: ids.type.vocabulary_id,
      vocabulary_name_snapshot: "type",
      term_name_snapshot: input.type_term,
      label_snapshot: null,
      position: "0",
    },
  ];
  if (input.horizon !== null) {
    terms.push({
      term_id: ids.memory_horizon.terms[input.horizon],
      vocabulary_id: ids.memory_horizon.vocabulary_id,
      vocabulary_name_snapshot: "memory_horizon",
      term_name_snapshot: input.horizon,
      label_snapshot: null,
      position: "1",
    });
  }
  return terms;
}

export const publishRevision = (b: Bank, ids: TaxonomyIds, input: PublishInput) =>
  call(b, "publishRevision", {
    operation_id: newPublicId(),
    content: {
      workspace_name: b.workspace,
      node_id: input.node_id,
      base_revision_id: input.base_revision_id,
      title: input.title,
      body: input.body,
      body_format: input.body_format,
      fields: "{}",
      author_peer_name: input.author_peer_name,
      observer_peer_name: null,
      subject_peer_name: null,
      session_name: input.session_name,
      is_active: true,
      valid_from: null,
      valid_to: null,
      change_reason: input.change_reason,
      schema_version: SCHEMA_VERSION,
      canonical_version: CANONICAL_VERSION,
      term_snapshot_json: JSON.stringify(termSnapshots(ids, input)),
      link_snapshot_json: JSON.stringify(input.links),
      h_metadata: null,
      internal_metadata: null,
    },
  });
