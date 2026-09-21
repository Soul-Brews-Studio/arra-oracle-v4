import { quote } from "./storage";
import { encodeTermRow, failTaxonomy, parseRenameTerm } from "./taxonomy";
import { TERMS } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { lookupTermByName } from "./service.lookupTermByName";
import { mutateTaxonomyWrite } from "./service.mutateTaxonomyWrite";
import { requireTaxonomyWorkspaceRow } from "./service.requireTaxonomyWorkspaceRow";
import { type Clock, type DatasetAdapter, type MutationOutcome, type OwnerCore } from "./service.types";
import { updateTerm } from "./service.updateTerm";

export function renameTerm(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock }, requestBytes: Uint8Array): Promise<MutationOutcome> {
return mutateTaxonomyWrite(core, async () => {
        const request = parseRenameTerm(requestBytes);
        await requireTaxonomyWorkspaceRow(writer, request.workspace_name);
        await writer.refresh(TERMS);
        const existing = await lookupTermById(writer, request.workspace_name, request.term_id);
        if (existing === null) failTaxonomy("not_found", "/term_id");
        const stored = encodeTermRow(existing);
        if (stored.is_active !== true) failTaxonomy("invalid_request", "/term_id");

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
