import { assertLocalDatasetRoot } from "./storage";
import { createContextReadMethods } from "./service.createContextReadMethods";
import { createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { makeAdapter } from "./service.makeAdapter";
import { makeReadMethods } from "./service.makeReadMethods";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { type ContextReaderBundle, type QueryEmbedder } from "./service.types";

/** Read all three facades over one gateless connection. Reads need no gate,
 *  no queue and no namespace configuration. `embedder` is the trusted query
 *  embedder `searchKnowledgeSemantic` uses (#30). */
export async function openContextReader(
  datasetRoot: string,
  options: { embedder?: QueryEmbedder } = {},
): Promise<ContextReaderBundle> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
    context: Object.freeze(createContextReadMethods(adapter, { embedder: options.embedder })),
  });
}
