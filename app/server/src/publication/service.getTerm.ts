import { quote } from "./storage";
import { encodeTermRow, parseGetTerm } from "./taxonomy";
import { TERMS, scopeOf } from "./service.constants";
import { readTaxonomy } from "./service.readTaxonomy";
import { scopedOne } from "./service.scopedOne";
import { type DatasetAdapter } from "./service.types";

export function getTerm(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
return readTaxonomy(async () => {
        const request = parseGetTerm(requestBytes);
        await reader.refresh(TERMS);
        // A staged term stays visible even when its vocabulary is absent: that
        // is a legitimate resume state, not corruption, and hiding it would
        // make a partial seed look like a fresh one.
        const row = await scopedOne(
          reader,
          TERMS,
          `${scopeOf(request.workspace_name)} AND id = ${quote(request.term_id)}`,
        );
        return row === null ? null : encodeTermRow(row);
      });
}
