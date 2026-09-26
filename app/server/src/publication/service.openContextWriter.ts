import { failPublication } from "./errors";
import { assertInheritedGate, assertLocalDatasetRoot } from "./storage";
import { assertSourceNamespace } from "./service.assertSourceNamespace";
import { createContextWriterService } from "./service.createContextWriterService";
import { createOwnerCore } from "./service.createOwnerCore";
import { createPublicationWriterService } from "./service.createPublicationWriterService";
import { createTaxonomyWriterService } from "./service.createTaxonomyWriterService";
import { makeAdapter } from "./service.makeAdapter";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { OWNERS } from "./service.owners";
import { type ContextOptions, type ContextWriterBundle, type DatasetAdapter } from "./service.types";

/**
 * One owner, three write facades.
 *
 * The bundle ALONE closes the owner: the nested publication facade carries its
 * data methods without `close`, and neither taxonomy nor context has one, so
 * no facade can release a gate another still depends on.
 *
 * `newRevisionId` stays required because the bundle offers publication.
 * Context operations never call it; allocating one lazily would hide a missing
 * dependency until the first publish.
 */
export async function openContextWriter(
  datasetRoot: string,
  options: ContextOptions,
): Promise<ContextWriterBundle> {
  // Namespace validity is decided BEFORE any connection is opened, so an
  // invalid configuration never takes the gate.
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
      createContextWriterService(adapter, core, {
        clock,
        sourceNamespace: options.sourceNamespace,
        documentEmbedder: options.documentEmbedder,
        digestProbe: options.digestProbe,
        datasetRoot: canonical,
      }),
    ),
    close: core.close,
  });
}
