import { quote } from "./storage";
import { TERM_FIELDS, encodeTermRow, failTaxonomy } from "./taxonomy";
import { TERMS, scopeOf } from "./service.constants";
import { lookupTermById } from "./service.lookupTermById";
import { type DatasetAdapter, type MutationOutcome, type OwnerCore, type TaxonomyRow } from "./service.types";

export async function updateTerm(writer: DatasetAdapter, core: OwnerCore, workspace: string, termId: string, assignments: Record<string, string>, guard: string, expected: TaxonomyRow): Promise<MutationOutcome> {
await core.taxonomyBoundary("before_write", false);
    core.markAttemptedWrite();
    const { rowsUpdated } = await core.afterWrite(async () =>
      writer.updateWhere(
        TERMS,
        `${scopeOf(workspace)} AND id = ${quote(termId)} AND ${guard}`,
        assignments,
      ),
    );
    // Anything but exactly one row is ambiguous: fail-stop, never guess.
    if (rowsUpdated !== 1) {
      core.poison();
      failTaxonomy("recovery_required");
    }
    await core.taxonomyBoundary("after_update", true);
    const row = await core.afterWrite(async () => {
      await writer.refresh(TERMS);
      const stored = await lookupTermById(writer, workspace, termId);
      if (stored === null) {
        core.poison();
        failTaxonomy("recovery_required");
      }
      const encoded = encodeTermRow(stored);
      // COMPARE, do not merely decode. Encoding proves the row is structurally
      // valid; it says nothing about whether it holds what we asked for. A
      // non-throwing hook that corrupts a field between the update and this
      // read would otherwise be accepted and returned as the result.
      for (const field of TERM_FIELDS) {
        if (encoded[field] !== expected[field]) {
          core.poison();
          failTaxonomy("recovery_required");
        }
      }
      return encoded;
    });
    await core.taxonomyBoundary("after_readback", true);
    return { outcome: "updated" as const, row };
}
