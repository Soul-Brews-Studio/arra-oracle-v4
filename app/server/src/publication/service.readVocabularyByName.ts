import { encodeVocabularyRow, parseLookupVocabularyByName } from "./taxonomy";
import { VOCABULARIES } from "./service.constants";
import { lookupVocabularyByName } from "./service.lookupVocabularyByName";
import { readTaxonomy } from "./service.readTaxonomy";
import { type DatasetAdapter } from "./service.types";

/**
 * K2: the transport-facing `lookupVocabularyByName` -- bytes in, the same
 * encoded row `getVocabulary` returns (or null) out. It reuses the exact
 * scoped lookup create/rename/seed already use, so the two can never disagree
 * about which row a name names.
 */
export function readVocabularyByName(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
  return readTaxonomy(async () => {
    const request = parseLookupVocabularyByName(requestBytes);
    await reader.refresh(VOCABULARIES);
    const row = await lookupVocabularyByName(reader, request.workspace_name, request.name);
    return row === null ? null : encodeVocabularyRow(row);
  });
}
