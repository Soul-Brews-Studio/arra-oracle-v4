import { parseReadRequest } from "./service.parseReadRequest";
import { readHeadAndAncestry } from "./service.readHeadAndAncestry";
import { terminalEventsFor } from "./service.evaluateEligibility";
import { type DatasetAdapter } from "./service.types";

/** #29 slice B: `lifecycle` is additive, same rationale as `getAcceptedHead`. */
export async function listAcceptedHistory(reader: DatasetAdapter, requestBytes: Uint8Array) {
const request = parseReadRequest(requestBytes);
      const found = await readHeadAndAncestry(reader, request);
      if (found === null) return null;
      const lifecycle = (await terminalEventsFor(reader, request.workspace_name, [request.node_id])).get(
        request.node_id,
      ) ?? null;
      return {
        node: found.node,
        // Named for THIS read's captured head, not a promise about later ones.
        snapshot_head_revision_id: found.headId,
        revisions: found.ancestry.encoded,
        lifecycle,
      };
}
