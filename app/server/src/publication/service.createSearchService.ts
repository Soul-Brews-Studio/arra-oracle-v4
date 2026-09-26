import { searchKnowledgeKeyword } from "./service.searchKnowledgeKeyword";
import { searchKnowledgeSemantic } from "./service.searchKnowledgeSemantic";
import { type DatasetAdapter, type QueryEmbedder } from "./service.types";

/**
 * The #30 knowledge searches (overnight R7 #30 part + R14), READER-only.
 *
 * Built over a gateless reader's adapter and composed into the reader
 * bundles' `context` facade (`openEvidenceReader`, `openContextReader`) --
 * never into a writer's, the way #32 / R9 moved `answerChat` onto the
 * reader-side chat facade. Both searches read and persist nothing, so neither
 * needs, holds or releases the writer. The writer keeps only the keyword
 * index MAINTENANCE (`indexRevisionChunks`); a reader never builds an index.
 *
 * `embedder` is the trusted query embedder semantic search uses
 * (`composition.ts` -> `createKnowledgeAccess` -> `openEvidenceReader`),
 * never request data and never a writer option. Absent, or on any embedder
 * failure, semantic search answers the closed `model_unavailable` code
 * (`service.embedSearchQuery.ts`; overnight R21, aligned with #32 / R9's
 * chat code); keyword search does not use it.
 *
 * `requestTimeMs` is the #29 validity-window `as_of` the recall-eligibility
 * check uses, supplied by the transport as real request time (R7 #29), the
 * same way `getRecallEligibility` takes it. Omitted, the eligibility kernel
 * falls back to its own clock (`service.getRecallEligibility.ts`).
 */
export function createSearchService(reader: DatasetAdapter, options: { embedder?: QueryEmbedder }) {
  return {
    searchKnowledgeKeyword: (requestBytes: Uint8Array, requestTimeMs?: number) =>
      searchKnowledgeKeyword(reader, requestBytes, requestTimeMs),
    searchKnowledgeSemantic: (requestBytes: Uint8Array, requestTimeMs?: number) =>
      searchKnowledgeSemantic(reader, options.embedder, requestBytes, requestTimeMs),
  };
}
