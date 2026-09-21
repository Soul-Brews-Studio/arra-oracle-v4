import { quote } from "./storage";
import { encodeTermRow, encodeVocabularyRow, failTaxonomy, parseRetireTerm } from "./taxonomy";
import { TERMS, VOCABULARIES, scopeOf } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { lookupVocabularyById } from "./service.lookupVocabularyById";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { type Clock, type DatasetAdapter, type MutationOutcome, type OwnerCore } from "./service.types";
import { updateTerm } from "./service.updateTerm";

export function retireTerm(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock }, requestBytes: Uint8Array): Promise<MutationOutcome> {
return mutateTaxonomyWrite(core, async () => {
        const request = parseRetireTerm(requestBytes);
        await requireTaxonomyWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(TERMS);
        await writer.refresh(VOCABULARIES);
        const existing = await lookupTermById(writer, request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);

        // The vocabulary is resolved BEFORE the satisfied return: an orphaned
        // term must name its problem rather than report already-satisfied and
        // leave the operator believing the state is fine.
        const vocabulary = await lookupVocabularyById(writer, 
          request.workspace_name,
          stored.vocabulary_id as string,
        );
        if (vocabulary === null) failTaxonomy("integrity_failure", "");

        // No reactivation exists, so an already-inactive term is satisfied.
        if (stored.is_active !== true) {
          return { outcome: "already_satisfied" as const, row: stored };
        }
        if (encodeVocabularyRow(vocabulary).required === true) {
          // Refuse retiring the LAST active term of a required vocabulary:
          // that would leave a required classification unsatisfiable.
          const active = await writer.query(
            TERMS,
            `${scopeOf(request.workspace_name)} AND vocabulary_id = ${quote(stored.vocabulary_id as string)} AND is_active = true`,
          );
          if (active.length <= 1) failTaxonomy("invalid_request", "/term_id");
        }

        // Children are deliberately NOT reparented or retired: a retired
        // parent may remain in historical tree structure.
        return await updateTerm(writer, core, 
          request.workspace_name,
          request.term_id,
          { is_active: "false" },
          "is_active = true",
          { ...stored, is_active: false },
        );
      });
}
