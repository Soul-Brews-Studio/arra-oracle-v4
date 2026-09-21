import { assertLocalDatasetRoot } from "./storage";
import { createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { makeAdapter } from "./service.makeAdapter";
import { makeReadMethods } from "./service.makeReadMethods";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { type KnowledgeReaderService } from "./service.types";

/**
 * Read both facades over one gateless connection.
 *
 * Reads need no gate and no queue, so this contends with nothing: a poisoned
 * or released writer elsewhere does not make a fresh reader unusable.
 */
export async function openKnowledgeReader(datasetRoot: string): Promise<KnowledgeReaderService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
  });
}
