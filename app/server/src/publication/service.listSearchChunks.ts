import { MAX_RESULT_WIRE_BYTES, rowWireBytes } from "./context";
import { failPublication } from "./errors";
import { EMPTY_ARRAY_BYTES } from "./rows";
import { encodeSearchChunkRow, parseListChunks } from "./search-chunk";
import { quote } from "./storage";
import { SEARCH_CHUNKS } from "./service.constants";
import { contextScope } from "./service.contextScope";
import { requireWorkspace } from "./service.requireWorkspace";
import { type DatasetAdapter } from "./service.types";

export async function listSearchChunks(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown>[]> {
const request = parseListChunks(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      await reader.refresh(SEARCH_CHUNKS);
      const rows = await reader.query(
        SEARCH_CHUNKS,
        `${contextScope(request.workspace_name)}` +
          ` AND revision_id = ${quote(request.revision_id)}` +
          ` AND chunker_version = ${quote(request.chunker_version)}` +
          ` AND embedding_profile = ${quote(request.embedding_profile)}`,
      );
      const encoded = rows.map((row) => encodeSearchChunkRow(row));
      // chunk_index is unique within this scope (see above), so this is a
      // real total order, not a tie-break over a non-unique key.
      encoded.sort((a, b) => {
        const left = BigInt(a.chunk_index as string);
        const right = BigInt(b.chunk_index as string);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      // Cumulative wire budget, matching listMessages: over budget fails, it
      // never truncates, which would hand back a short page indistinguishable
      // from a real one.
      let budget = EMPTY_ARRAY_BYTES;
      for (const row of encoded) {
        budget += rowWireBytes(row) + 1;
        if (budget > MAX_RESULT_WIRE_BYTES) failPublication("limit_exceeded", "");
      }
      return encoded;
}
