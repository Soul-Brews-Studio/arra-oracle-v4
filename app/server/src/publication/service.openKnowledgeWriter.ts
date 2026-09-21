import { failPublication } from "./errors";
import { assertInheritedGate, assertLocalDatasetRoot } from "./storage";
import { createOwnerCore } from "./service.createOwnerCore";
import { createPublicationWriterService } from "./service.createPublicationWriterService";
import { createTaxonomyWriterService } from "./service.createTaxonomyWriterService";
import { makeAdapter } from "./service.makeAdapter";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { OWNERS } from "./service.owners";
import { type DatasetAdapter, type KnowledgeOptions, type KnowledgeWriterService } from "./service.types";

/**
 * One owner, two write facades.
 *
 * The bundle ALONE closes the owner: `publication` here carries its three data
 * methods without `close`, and `taxonomy` has no `close` at all, so neither
 * facade can release a gate the other still depends on.
 *
 * Because the bundle offers publication, it requires the existing
 * `newRevisionId` dependency even when a caller only touches taxonomy --
 * taxonomy never calls it, and allocating one lazily would hide a missing
 * dependency until the first publish.
 */
export async function openKnowledgeWriter(
  datasetRoot: string,
  options: KnowledgeOptions,
): Promise<KnowledgeWriterService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  // Gate and single-owner claim BOTH precede connect, exactly as the
  // publication writer does: cross-factory opens on the same root contend.
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
  });
  const publication = createPublicationWriterService(
    adapter,
    { clock, newRevisionId: options.newRevisionId },
    core,
  );
  const taxonomy = createTaxonomyWriterService(adapter, core, { clock });

  const { close: _ownedByTheBundle, ...publicationData } = publication;
  return Object.freeze({
    publication: Object.freeze(publicationData),
    taxonomy: Object.freeze(taxonomy),
    close: core.close,
  });
}
