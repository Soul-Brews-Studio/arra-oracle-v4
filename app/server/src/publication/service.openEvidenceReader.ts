import { assertLocalDatasetRoot } from "./storage";
import { createContextReadMethods } from "./service.createContextReadMethods";
import { createEvidenceReadMethods } from "./service.createEvidenceReadMethods";
import { createSearchService } from "./service.createSearchService";
import { createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { makeAdapter } from "./service.makeAdapter";
import { makeReadMethods } from "./service.makeReadMethods";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { type EvidenceReaderBundle, type QueryEmbedder } from "./service.types";

/** Four facades over one gateless connection. No gate, no queue. The context
 *  facade also carries the reader-only #30 searches; `embedder` is the
 *  trusted query embedder semantic search uses (`service.createSearchService.ts`). */
export async function openEvidenceReader(
  datasetRoot: string,
  options: { embedder?: QueryEmbedder } = {},
): Promise<EvidenceReaderBundle> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
    context: Object.freeze({
      ...createContextReadMethods(adapter),
      ...createSearchService(adapter, { embedder: options.embedder }),
    }),
    evidence: Object.freeze(createEvidenceReadMethods(adapter)),
  });
}
