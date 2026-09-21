import { quote } from "./storage";
import { encodeTermRow, encodeVocabularyRow, failTaxonomy, parseReparentTerm } from "./taxonomy";
import { assertAncestryIsSafe } from "./service.assertAncestryIsSafe";
import { TERMS, VOCABULARIES } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { lookupVocabularyById } from "./service.lookupVocabularyById";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { type Clock, type DatasetAdapter, type MutationOutcome, type OwnerCore } from "./service.types";
import { updateTerm } from "./service.updateTerm";

export function reparentTerm(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock }, requestBytes: Uint8Array): Promise<MutationOutcome> {
return mutateTaxonomyWrite(core, async () => {
        const request = parseReparentTerm(requestBytes);
        await requireTaxonomyWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(TERMS);
        await writer.refresh(VOCABULARIES);
        const existing = await lookupTermById(writer, request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);
        if (stored.is_active !== true) failTaxonomy("invalid_request", "/term_id");

        const vocabulary = await lookupVocabularyById(writer, 
          request.workspace_name,
          stored.vocabulary_id as string,
        );
        if (vocabulary === null) failTaxonomy("integrity_failure", "");
        const hierarchy = encodeVocabularyRow(vocabulary).hierarchy;

        if (hierarchy !== "tree") {
          // A flat vocabulary accepts only a null desired parent, and a
          // malformed non-null STORED parent is corruption this operation
          // deliberately refuses to repair.
          if (request.parent_id !== null) failTaxonomy("invalid_request", "/parent_id");
          if (stored.parent_id !== null) failTaxonomy("integrity_failure", "");
        }

        if (request.parent_id !== null) {
          if (request.parent_id === request.term_id) failTaxonomy("invalid_request", "/parent_id");
          // Validate the requested structure BEFORE any already-satisfied
          // shortcut: "desired equals current" must not skip cycle detection.
          await assertAncestryIsSafe(writer, 
            request.workspace_name,
            stored.vocabulary_id as string,
            request.term_id,
            request.parent_id,
          );
        }

        if (stored.parent_id === request.parent_id) {
          return { outcome: "already_satisfied" as const, row: stored };
        }
        if (stored.parent_id !== request.expected_parent_id) {
          failTaxonomy("conflict", "/expected_parent_id");
        }

        const guard =
          request.expected_parent_id === null
            ? "parent_id IS NULL"
            : `parent_id = ${quote(request.expected_parent_id)}`;
        return await updateTerm(writer, core, 
          request.workspace_name,
          request.term_id,
          { parent_id: request.parent_id === null ? "NULL" : quote(request.parent_id) },
          guard,
          { ...stored, parent_id: request.parent_id },
        );
      });
}
