import { assertLocalDatasetRoot } from "./storage";
import { createContextReadMethods } from "./service.createContextReadMethods";
import { createEvidenceReadMethods } from "./service.createEvidenceReadMethods";
import { createTaxonomyReadMethods } from "./service.createTaxonomyReadMethods";
import { makeAdapter } from "./service.makeAdapter";
import { makeReadMethods } from "./service.makeReadMethods";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { type EvidenceReaderBundle } from "./service.types";

/** Four facades over one gateless connection. No gate, no queue. */
export async function openEvidenceReader(datasetRoot: string): Promise<EvidenceReaderBundle> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return Object.freeze({
    publication: Object.freeze(makeReadMethods(adapter)),
    taxonomy: Object.freeze(createTaxonomyReadMethods(adapter)),
    context: Object.freeze(createContextReadMethods(adapter)),
    evidence: Object.freeze(createEvidenceReadMethods(adapter)),
  });
}
