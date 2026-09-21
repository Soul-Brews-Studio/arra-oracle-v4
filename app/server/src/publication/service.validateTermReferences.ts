import { failPublication } from "./errors";
import { quote } from "./storage";
import { MEMORY_HORIZON_VOCABULARY, RESERVED_TYPE_VOCABULARY } from "./service.constants";
import { parseSnapshotArray } from "./service.parseSnapshotArray";
import { requireExactlyOne } from "./service.requireExactlyOne";
import { type DatasetAdapter, type TermSnapshotEntry } from "./service.types";

/**
 * Terms, vocabularies and workspace policy for NEW content.
 *
 * Historical accepted rows are validated against their OWN frozen snapshots
 * elsewhere; this runs only for a new publication or an unpublished-orphan
 * resumption, so a term renamed or retired later never invalidates history.
 */
export async function validateTermReferences(
  adapter: DatasetAdapter,
  workspace: string,
  encoded: Record<string, unknown>,
): Promise<void> {
  const entries = parseSnapshotArray(encoded.term_snapshot_json, "/content/term_snapshot_json");
  const seenVocabularies = new Map<string, Record<string, unknown>>();
  const assignmentsByVocabulary = new Map<string, number>();
  let reservedTypeAssignments = 0;
  let horizonAssignments = 0;

  for (const raw of entries) {
    const entry = raw as unknown as TermSnapshotEntry;
    // label_snapshot MUST be null for NEW content: Term has no authoritative
    // label column, and Vocabulary.label names a VOCABULARY, not a term.
    // Conflating them would fabricate provenance.
    if (entry.label_snapshot !== null && entry.label_snapshot !== undefined) {
      failPublication("invalid_request", "/content/term_snapshot_json");
    }

    const term = await requireExactlyOne(
      adapter,
      "terms",
      `workspace_name = ${quote(workspace)} AND id = ${quote(entry.term_id)}`,
      "/content/term_snapshot_json",
    );
    if (term.vocabulary_id !== entry.vocabulary_id) {
      failPublication("invalid_reference", "/content/term_snapshot_json");
    }
    // A NEW assignment requires an ACTIVE term; retired terms stay readable
    // in history but cannot be newly assigned.
    if (term.is_active !== true) failPublication("invalid_reference", "/content/term_snapshot_json");
    if (term.name !== entry.term_name_snapshot) {
      failPublication("invalid_reference", "/content/term_snapshot_json");
    }

    let vocabulary = seenVocabularies.get(entry.vocabulary_id);
    if (vocabulary === undefined) {
      vocabulary = await requireExactlyOne(
        adapter,
        "vocabularies",
        `workspace_name = ${quote(workspace)} AND id = ${quote(entry.vocabulary_id)}`,
        "/content/term_snapshot_json",
      );
      seenVocabularies.set(entry.vocabulary_id, vocabulary);
    }
    if (vocabulary.name !== entry.vocabulary_name_snapshot) {
      failPublication("invalid_reference", "/content/term_snapshot_json");
    }
    // NOTE: a SEALED vocabulary still permits assigning an existing active
    // term. Sealing governs term CREATION, not assignment.
    if (vocabulary.kind !== "tags" && vocabulary.kind !== "categories") {
      failPublication("integrity_failure", "/content/term_snapshot_json");
    }
    if (vocabulary.cardinality !== "one" && vocabulary.cardinality !== "many") {
      failPublication("integrity_failure", "/content/term_snapshot_json");
    }

    const count = (assignmentsByVocabulary.get(entry.vocabulary_id) ?? 0) + 1;
    assignmentsByVocabulary.set(entry.vocabulary_id, count);
    if (vocabulary.cardinality === "one" && count > 1) {
      failPublication("invalid_request", "/content/term_snapshot_json");
    }
    if (vocabulary.name === RESERVED_TYPE_VOCABULARY) reservedTypeAssignments += 1;
    if (vocabulary.name === MEMORY_HORIZON_VOCABULARY) horizonAssignments += 1;
  }

  // Reserved constraints hold even if policy columns were configured loosely.
  const typeVocabularies = await adapter.query(
    "vocabularies",
    `workspace_name = ${quote(workspace)} AND name = ${quote(RESERVED_TYPE_VOCABULARY)}`,
  );
  if (typeVocabularies.length !== 1) failPublication("integrity_failure", "/content/term_snapshot_json");
  if (reservedTypeAssignments !== 1) failPublication("invalid_request", "/content/term_snapshot_json");

  const horizonVocabularies = await adapter.query(
    "vocabularies",
    `workspace_name = ${quote(workspace)} AND name = ${quote(MEMORY_HORIZON_VOCABULARY)}`,
  );
  if (horizonVocabularies.length > 1) failPublication("integrity_failure", "/content/term_snapshot_json");
  if (horizonAssignments > 1) failPublication("invalid_request", "/content/term_snapshot_json");

  // Every required=true workspace vocabulary needs at least one assignment.
  const allVocabularies = await adapter.query("vocabularies", `workspace_name = ${quote(workspace)}`);
  for (const vocabulary of allVocabularies) {
    if (vocabulary.required !== true) continue;
    if ((assignmentsByVocabulary.get(vocabulary.id as string) ?? 0) < 1) {
      failPublication("invalid_request", "/content/term_snapshot_json");
    }
  }
}
