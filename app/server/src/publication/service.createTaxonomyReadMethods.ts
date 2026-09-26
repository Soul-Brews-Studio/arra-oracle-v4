import { getTerm } from "./service.getTerm";
import { getVocabulary } from "./service.getVocabulary";
import { knowledgeStats } from "./service.knowledgeStats";
import { listTermUsage } from "./service.listTermUsage";
import { listTerms } from "./service.listTerms";
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
    // K6+K7 (docs/overnight/V3-PARITY.md §5, DECISIONS.md R18 (K6+K7+V8)):
    // term listing, term usage counts and workspace-wide knowledge stats.
    listTerms: (requestBytes: Uint8Array) => listTerms(reader, requestBytes),
    listTermUsage: (requestBytes: Uint8Array) => listTermUsage(reader, requestBytes),
    knowledgeStats: (requestBytes: Uint8Array) => knowledgeStats(reader, requestBytes),
  };
}
