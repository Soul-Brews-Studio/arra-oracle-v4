import { failPublication } from "./errors";
import { assertInheritedGate, assertLocalDatasetRoot } from "./storage";
import { createOwnerCore } from "./service.createOwnerCore";
import { createPublicationWriterService } from "./service.createPublicationWriterService";
import { makeAdapter } from "./service.makeAdapter";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { OWNERS } from "./service.owners";
import { type DatasetAdapter, type OperatorOptions, type PublicationWriterService } from "./service.types";

export async function openPublicationWriter(
  datasetRoot: string,
  options: OperatorOptions,
): Promise<PublicationWriterService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  // Gate and single-owner claim BOTH precede connect, so a refused writer
  // never opens a writable connection at all.
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

  const core = createOwnerCore(adapter, { onBoundary: options.onBoundary });
  return createPublicationWriterService(
    adapter,
    { clock: options.clock ?? Date.now, newRevisionId: options.newRevisionId },
    core,
  );
}
