import { requestBytes } from "./db.legacyRead.requestBytes";
import { openTarget19MemoryReader } from "./db.legacyRead.openTarget19MemoryReader";
import { mapAcceptedHeadToMemory, type LegacyMemoryRow } from "./db.legacyRead.mapAcceptedHeadToMemory";

/** Target-19-backed `db.getById`: `node_id` <- legacy `id` (`buildRevisionRequest.ts`). */
export async function legacyReadGetById(bank: string, id: string): Promise<LegacyMemoryRow | null> {
  const bundle = await openTarget19MemoryReader();
  const found = (await bundle.publication.getAcceptedHead(
    requestBytes({ workspace_name: bank, node_id: id }),
  )) as { node: Record<string, unknown>; revision: Record<string, unknown>; lifecycle: { kind: string; new_id: string | null } | null } | null;
  if (found === null) return null;
  return mapAcceptedHeadToMemory(found);
}
