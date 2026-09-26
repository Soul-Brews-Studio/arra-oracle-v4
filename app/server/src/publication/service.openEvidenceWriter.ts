import { failPublication } from "./errors";
import { assertInheritedGate, assertLocalDatasetRoot } from "./storage";
import { assertSourceNamespace } from "./service.assertSourceNamespace";
import { createContextWriterService } from "./service.createContextWriterService";
import { createEvidenceWriterService } from "./service.createEvidenceWriterService";
import { createOwnerCore } from "./service.createOwnerCore";
import { createPublicationWriterService } from "./service.createPublicationWriterService";
import { createTaxonomyWriterService } from "./service.createTaxonomyWriterService";
import { makeAdapter } from "./service.makeAdapter";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { OWNERS } from "./service.owners";
import { type DatasetAdapter, type EvidenceOptions, type EvidenceWriterBundle } from "./service.types";

/**
 * One owner, four write facades.
 *
 * The bundle ALONE closes the owner. Nested facades carry no close, so no
 * facade can release a gate another still depends on.
 */
export async function openEvidenceWriter(
  datasetRoot: string,
  options: EvidenceOptions,
): Promise<EvidenceWriterBundle> {
  assertSourceNamespace(options.sourceNamespace);
  const canonical = assertLocalDatasetRoot(datasetRoot);
  assertInheritedGate(canonical, options.env);
  if (OWNERS.has(canonical)) failPublication("writer_unavailable");
  const token = Symbol(canonical);
  OWNERS.set(canonical, token);

  let adapter: DatasetAdapter;
  try {
    adapter = makeAdapter(await openPrivateConnection(canonical), () => {
      if (OWNERS.get(canonical) === token) OWNERS.delete(canonical);
    });
  } catch (error) {
    OWNERS.delete(canonical);
    throw error;
  }

  const clock = options.clock ?? Date.now;
  const core = createOwnerCore(adapter, {
    onBoundary: options.onBoundary,
    onTaxonomyBoundary: options.onTaxonomyBoundary,
    onContextBoundary: options.onContextBoundary,
    onEvidenceBoundary: options.onEvidenceBoundary,
  });
  const publication = createPublicationWriterService(
    adapter,
    { clock, newRevisionId: options.newRevisionId },
    core,
  );
  const { close: _ownedByTheBundle, ...publicationData } = publication;

  return Object.freeze({
    publication: Object.freeze(publicationData),
    taxonomy: Object.freeze(
      createTaxonomyWriterService(adapter, core, { clock, taxonomyOperator: options.taxonomyOperator === true }),
    ),
    context: Object.freeze(
      createContextWriterService(adapter, core, { clock, sourceNamespace: options.sourceNamespace }),
    ),
    evidence: Object.freeze(createEvidenceWriterService(adapter, core)),
    close: core.close,
  });
}
