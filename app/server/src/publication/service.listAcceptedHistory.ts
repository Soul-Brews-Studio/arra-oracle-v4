import { parseReadRequest } from "./service.parseReadRequest";
import { readHeadAndAncestry } from "./service.readHeadAndAncestry";
import { type DatasetAdapter } from "./service.types";

export async function listAcceptedHistory(reader: DatasetAdapter, requestBytes: Uint8Array) {
const request = parseReadRequest(requestBytes);
      const found = await readHeadAndAncestry(reader, request);
      if (found === null) return null;
      return {
        node: found.node,
        // Named for THIS read's captured head, not a promise about later ones.
        snapshot_head_revision_id: found.headId,
        revisions: found.ancestry.encoded,
      };
}
