import { getTerm } from "./service.getTerm";
import { getVocabulary } from "./service.getVocabulary";
import { readTermByName } from "./service.readTermByName";
import { readVocabularyByName } from "./service.readVocabularyByName";
import { type DatasetAdapter } from "./service.types";

export function createTaxonomyReadMethods(reader: DatasetAdapter) {
  return {
    getVocabulary: (requestBytes: Uint8Array) => getVocabulary(reader, requestBytes),
    getTerm: (requestBytes: Uint8Array) => getTerm(reader, requestBytes),
    // K2 (docs/overnight/V3-PARITY.md §5): by-name reads, content:read.
    lookupVocabularyByName: (requestBytes: Uint8Array) => readVocabularyByName(reader, requestBytes),
    lookupTermByName: (requestBytes: Uint8Array) => readTermByName(reader, requestBytes),
  };
}
