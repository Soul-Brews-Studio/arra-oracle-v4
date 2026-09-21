import { assertLocalDatasetRoot } from "./storage";
import { createPublicationReaderService } from "./service.createPublicationReaderService";
import { makeAdapter } from "./service.makeAdapter";
import { openPrivateConnection } from "./service.openPrivateConnection";
import { type PublicationReaderService } from "./service.types";

/**
 * The contracted factories.
 *
 * These are the ONLY publication entrypoints. Each returns a frozen object
 * carrying exactly the contracted methods -- no adapter, no connection, no
 * table and no caller-mintable owner handle escapes through them.
 */
export async function openPublicationReader(datasetRoot: string): Promise<PublicationReaderService> {
  const canonical = assertLocalDatasetRoot(datasetRoot);
  // Reading needs no gate, and this adapter exposes no mutator to the
  // read-only service built over it.
  const adapter = makeAdapter(await openPrivateConnection(canonical), () => {});
  return createPublicationReaderService(adapter);
}
