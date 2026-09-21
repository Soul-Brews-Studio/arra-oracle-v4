import { quote } from "./storage";
import { encodeVocabularyRow, parseGetVocabulary } from "./taxonomy";
import { VOCABULARIES, scopeOf } from "./service.constants";
import { readTaxonomy } from "./service.readTaxonomy";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export function getVocabulary(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
return readTaxonomy(async () => {
        const request = parseGetVocabulary(requestBytes);
        await reader.refresh(VOCABULARIES);
        const row = await scopedOne(
          reader,
          VOCABULARIES,
          `${scopeOf(request.workspace_name)} AND id = ${quote(request.vocabulary_id)}`,
        );
        return row === null ? null : encodeVocabularyRow(row);
      });
}
