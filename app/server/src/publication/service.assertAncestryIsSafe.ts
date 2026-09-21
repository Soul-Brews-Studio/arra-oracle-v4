import { encodeTermRow, failTaxonomy } from "./taxonomy";
import { lookupTermById } from "./service.lookupTermById";
import { type DatasetAdapter } from "./service.types";

export async function assertAncestryIsSafe(writer: DatasetAdapter, workspace: string, vocabularyId: string, termId: string, desiredParentId: string): Promise<void> {
const parent = await lookupTermById(writer, workspace, desiredParentId);
    if (parent === null) failTaxonomy("invalid_reference", "/parent_id");
    const parentRow = encodeTermRow(parent);
    if (parentRow.is_active !== true) failTaxonomy("invalid_request", "/parent_id");
    if (parentRow.vocabulary_id !== vocabularyId) failTaxonomy("invalid_reference", "/parent_id");

    let cursor: string | null = desiredParentId;
    let visited = 0;
    const seen = new Set<string>();
    while (cursor !== null) {
      visited += 1;
      if (visited > 1024) failTaxonomy("limit_exceeded", "");
      // Reaching the term being moved means the requested parent sits BELOW
      // it: that is the cycle.
      if (cursor === termId) failTaxonomy("invalid_request", "/parent_id");
      if (seen.has(cursor)) failTaxonomy("integrity_failure", "");
      seen.add(cursor);
      const row: Record<string, unknown> | null = await lookupTermById(writer, workspace, cursor);
      if (row === null) failTaxonomy("integrity_failure", "");
      const encoded = encodeTermRow(row);
      if (encoded.vocabulary_id !== vocabularyId) failTaxonomy("integrity_failure", "");
      cursor = (encoded.parent_id as string | null) ?? null;
    }
}
