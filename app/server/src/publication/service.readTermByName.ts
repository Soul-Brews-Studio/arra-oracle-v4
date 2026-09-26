import { encodeTermRow, parseLookupTermByName } from "./taxonomy";
import { TERMS } from "./service.constants";
import { lookupTermByName } from "./service.lookupTermByName";
import { readTaxonomy } from "./service.readTaxonomy";
import { type DatasetAdapter } from "./service.types";

/**
 * K2: the transport-facing `lookupTermByName` -- bytes in, the same encoded
 * row `getTerm` returns (or null) out, found by the same scoped lookup the
 * create path uses. A retired term is still returned (with `is_active:false`),
 * exactly as `getTerm` would: whether an inactive term is usable is the
 * caller's decision, and hiding it would make a name look free when a create
 * would still conflict.
 */
export function readTermByName(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
  return readTaxonomy(async () => {
    const request = parseLookupTermByName(requestBytes);
    await reader.refresh(TERMS);
    const row = await lookupTermByName(reader, request.workspace_name, request.vocabulary_id, request.name);
    return row === null ? null : encodeTermRow(row);
  });
}
