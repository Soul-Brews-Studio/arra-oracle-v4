import { TERM_FIELDS, encodeTermRow, encodeVocabularyRow, failTaxonomy, parseCreateTerm } from "./taxonomy";
import { assertAncestryIsSafe } from "./service.assertAncestryIsSafe";
import { TERMS, VOCABULARIES } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { lookupTermByName } from "./service.lookupTermByName";
import { lookupVocabularyById } from "./service.lookupVocabularyById";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { sameExcept } from "./service.sameExcept";
import { type Clock, type DatasetAdapter, type MutationOutcome, type OwnerCore, type TaxonomyRow } from "./service.types";
import { writeTaxonomyRow } from "./service.writeTaxonomyRow";

export function createTerm(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock }, requestBytes: Uint8Array): Promise<MutationOutcome> {
return mutateTaxonomyWrite(core, async () => {
        const request = parseCreateTerm(requestBytes);
        await requireTaxonomyWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(VOCABULARIES);
        await writer.refresh(TERMS);

        // Foreign references first: a missing or cross-workspace vocabulary is
        // an invalid reference, not a conflict.
        const vocabulary = await lookupVocabularyById(writer, request.workspace_name, request.vocabulary_id);
        if (vocabulary === null) failTaxonomy("invalid_reference", "/vocabulary_id");
        const vocabularyRow = encodeVocabularyRow(vocabulary);

        if (request.parent_id !== null) {
          if (vocabularyRow.hierarchy !== "tree") failTaxonomy("invalid_request", "/parent_id");
          // The WHOLE ancestry, bounded and scoped -- not just the immediate
          // parent. A parent can be active and in-vocabulary while its own
          // ancestor is missing or cyclic, and attaching beneath it would add
          // a new row to a chain that is already structurally invalid.
          await assertAncestryIsSafe(writer, 
            request.workspace_name,
            request.vocabulary_id,
            request.term_id,
            request.parent_id,
          );
        }

        const expected: TaxonomyRow = {
          id: request.term_id,
          workspace_name: request.workspace_name,
          vocabulary_id: request.vocabulary_id,
          name: request.name,
          description: request.description,
          parent_id: request.parent_id,
          weight: 0,
          is_active: true,
          h_metadata: null,
          created_at: BigInt(options.clock()) * 1000n,
        };

        // Uniqueness is validated BEFORE any satisfied return. A matching ID
        // does not excuse a DIFFERENT row holding the same scoped name, and
        // reporting already-satisfied over that would call a corrupt dataset
        // healthy. Name collisions include retired rows: a retired name still
        // occupies its scoped identity.
        const byName = await lookupTermByName(writer, 
          request.workspace_name,
          request.vocabulary_id,
          request.name,
        );
        if (byName !== null && byName.id !== request.term_id) failTaxonomy("conflict", "/name");

        const byId = await lookupTermById(writer, request.workspace_name, request.term_id);
        if (byId !== null) {
          const stored = encodeTermRow(byId);
          if (!sameExcept(stored, encodeTermRow(expected), TERM_FIELDS)) {
            failTaxonomy("conflict", "/term_id");
          }
          return { outcome: "already_satisfied" as const, row: stored };
        }

        await writeTaxonomyRow(writer, core, TERMS, expected, "after_term_write", false);
        return { outcome: "created" as const, row: encodeTermRow(expected) };
      });
}
