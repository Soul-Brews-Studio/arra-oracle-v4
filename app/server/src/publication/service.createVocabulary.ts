import { VOCABULARY_FIELDS, encodeVocabularyRow, failTaxonomy, parseCreateVocabulary } from "./taxonomy";
import { VOCABULARIES } from "./service.constants";
import { lookupVocabularyById } from "./service.lookupVocabularyById";
import { lookupVocabularyByName } from "./service.lookupVocabularyByName";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { sameExcept } from "./service.sameExcept";
import { type Clock, type DatasetAdapter, type MutationOutcome, type OwnerCore, type TaxonomyRow } from "./service.types";
import { writeTaxonomyRow } from "./service.writeTaxonomyRow";

export function createVocabulary(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock }, requestBytes: Uint8Array): Promise<MutationOutcome> {
return mutateTaxonomyWrite(core, async () => {
        const request = parseCreateVocabulary(requestBytes);
        // Preflight the WHOLE request before mutating anything.
        await requireTaxonomyWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(VOCABULARIES);
        const byId = await lookupVocabularyById(writer, request.workspace_name, request.vocabulary_id);
        const byName = await lookupVocabularyByName(writer, request.workspace_name, request.name);

        const expected: TaxonomyRow = {
          id: request.vocabulary_id,
          name: request.name,
          workspace_name: request.workspace_name,
          label: request.label,
          description: request.description,
          kind: request.kind,
          term_policy: request.term_policy,
          cardinality: request.cardinality,
          required: request.required,
          hierarchy: request.hierarchy,
          h_metadata: null,
          internal_metadata: null,
          created_at: BigInt(options.clock()) * 1000n,
        };

        if (byId !== null) {
          const stored = encodeVocabularyRow(byId);
          // A row at the requested ID is the EXPECTED row, not a collision
          // merely because it exists. Only a mismatch conflicts.
          if (!sameExcept(stored, encodeVocabularyRow(expected), VOCABULARY_FIELDS)) {
            failTaxonomy("conflict", "/vocabulary_id");
          }
          return { outcome: "already_satisfied" as const, row: stored };
        }
        // A DIFFERENT id already occupying this scoped name conflicts on name.
        if (byName !== null) failTaxonomy("conflict", "/name");

        await writeTaxonomyRow(writer, core, VOCABULARIES, expected, "after_vocabulary_write", false);
        return { outcome: "created" as const, row: encodeVocabularyRow(expected) };
      });
}
