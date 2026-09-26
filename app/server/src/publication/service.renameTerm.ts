import { quote } from "./storage";
import { encodeTermRow, encodeVocabularyRow, failTaxonomy, parseRenameTerm } from "./taxonomy";
import { TERMS, VOCABULARIES } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { lookupTermByName } from "./service.lookupTermByName";
import { lookupVocabularyById } from "./service.lookupVocabularyById";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { refuseSealedVocabulary } from "./service.refuseSealedVocabulary";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { type DatasetAdapter, type MutationOutcome, type OwnerCore, type TaxonomyWriteOptions } from "./service.types";
import { updateTerm } from "./service.updateTerm";

export function renameTerm(writer: DatasetAdapter, core: OwnerCore, options: TaxonomyWriteOptions, requestBytes: Uint8Array): Promise<MutationOutcome> {
return mutateTaxonomyWrite(core, async () => {
        const request = parseRenameTerm(requestBytes);
        await requireTaxonomyWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(TERMS);
        await writer.refresh(VOCABULARIES);
        const existing = await lookupTermById(writer, request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);
        if (stored.is_active !== true) failTaxonomy("invalid_request", "/term_id");

        // R6: the term's vocabulary decides whether it may be renamed at all,
        // so it is resolved -- an orphan names its problem, exactly as retire
        // and reparent already do -- and a sealed one refuses BEFORE the
        // collision, satisfied and expected-name checks below.
        const vocabulary = await lookupVocabularyById(writer, 
          request.workspace_name,
          stored.vocabulary_id as string,
        );
        if (vocabulary === null) failTaxonomy("integrity_failure", "");
        refuseSealedVocabulary(encodeVocabularyRow(vocabulary), options, "/term_id");

        // Uniqueness FIRST, so an already-satisfied rename cannot skip it.
        // Collisions include RETIRED rows: a retired name still occupies its
        // scoped identity and must not be reused.
        const clash = await lookupTermByName(writer, 
          request.workspace_name,
          stored.vocabulary_id as string,
          request.name,
        );
        if (clash !== null && clash.id !== request.term_id) failTaxonomy("conflict", "/name");

        // DESIRED first, then expected. Comparing expected first would report a
        // guard mismatch for a request that is already satisfied.
        if (stored.name === request.name) {
          return { outcome: "already_satisfied" as const, row: stored };
        }
        if (stored.name !== request.expected_name) failTaxonomy("conflict", "/expected_name");

        return await updateTerm(writer, core, 
          request.workspace_name,
          request.term_id,
          { name: quote(request.name) },
          `name = ${quote(request.expected_name)}`,
          { ...stored, name: request.name },
        );
      });
}
