import { assertLocalDatasetRoot } from "./storage";
import { createContextReadMethods } from "./service.createContextReadMethods";
import { createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { makeAdapter } from "./service.makeAdapter";
import { makeReadMethods } from "./service.makeReadMethods";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { type ContextReaderBundle } from "./service.types";

/** Read all three facades over one gateless connection. Reads need no gate,
 *  no queue and no namespace configuration. */
export async function openContextReader(datasetRoot: string): Promise<ContextReaderBundle> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
    context: Object.freeze(createContextReadMethods(adapter)),
  });
}
