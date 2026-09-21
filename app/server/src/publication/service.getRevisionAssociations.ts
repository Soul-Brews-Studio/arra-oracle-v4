import { MAX_RESULT_WIRE_BYTES as MAX_EVIDENCE_WIRE_BYTES, parseGetRevisionAssociations } from "./association";
import { failPublication } from "./errors";
import { associationsFor } from "./service.associationsFor";
import { requireWorkspace } from "./service.requireWorkspace";
import { selectAcceptedRevision } from "./service.selectAcceptedRevision";
import { type DatasetAdapter } from "./service.types";
import { wireBytesOf } from "./service.wireBytesOf";

export async function getRevisionAssociations(reader: DatasetAdapter, requestBytes: Uint8Array): Promise<Record<string, unknown> | null> {
const request = parseGetRevisionAssociations(requestBytes);
      await requireWorkspace(reader, request.workspace_name);
      const resolved = await selectAcceptedRevision(
        reader,
        request.workspace_name,
        request.node_id,
        request.revision_id,
      );
      if (resolved === null) return null;
      const result = associationsFor(
        request.workspace_name,
        request.node_id,
        resolved.head,
        resolved.selected,
      );
      if (wireBytesOf(result) > MAX_EVIDENCE_WIRE_BYTES) failPublication("limit_exceeded", "");
      return result;
}
