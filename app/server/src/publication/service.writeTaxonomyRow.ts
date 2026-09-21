import { quote } from "./storage";
import { TERM_FIELDS, VOCABULARY_FIELDS, encodeTermRow, encodeVocabularyRow, failTaxonomy } from "./taxonomy";
import { type TaxonomyBoundary } from "./service.boundaries";
import { TERMS, scopeOf } from "./service.constants";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter, type OwnerCore, type TaxonomyRow } from "./service.types";

export async function writeTaxonomyRow(writer: DatasetAdapter, core: OwnerCore, table: string, row: TaxonomyRow, successBoundary: TaxonomyBoundary, wroteAlready: boolean): Promise<void> {
await core.taxonomyBoundary("before_write", wroteAlready);
    core.markAttemptedWrite();
    try {
      await writer.append(table, [row]);
    } catch {
      core.poison();
      failTaxonomy("recovery_required");
    }
    await core.taxonomyBoundary(successBoundary, true);
    await core.afterWrite(async () => {
      await writer.refresh(table);
      const id = row.id as string;
      const workspace = row.workspace_name as string;
      const stored = await scopedOne(
        writer,
        table,
        `${scopeOf(workspace)} AND id = ${quote(id)}`,
      );
      if (stored === null) {
        core.poison();
        failTaxonomy("recovery_required");
      }
      const encoded = table === TERMS ? encodeTermRow(stored) : encodeVocabularyRow(stored);
      const fields = table === TERMS ? TERM_FIELDS : VOCABULARY_FIELDS;
      const expected = table === TERMS ? encodeTermRow(row) : encodeVocabularyRow(row);
      for (const field of fields) {
        if (encoded[field] !== expected[field]) {
          core.poison();
          failTaxonomy("recovery_required");
        }
      }
    });
    await core.taxonomyBoundary("after_readback", true);
}
