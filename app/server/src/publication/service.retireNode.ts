import { type ChatModelFn } from "./chat";
import { parseRetireNode } from "./lifecycle";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { requireContextWorkspaceRow } from "./service.requireContextWorkspaceRow";
import { type Clock, type DatasetAdapter, type LifecycleWriteOutcome, type OwnerCore } from "./service.types";
import { writeContextRow } from "./service.writeContextRow";
import { writeLifecycleEvent } from "./service.writeLifecycleEvent";

export function retireNode(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array): Promise<LifecycleWriteOutcome> {
const request = parseRetireNode(requestBytes);
      return mutateContextWrite(core, () =>
        writeLifecycleEvent(writer, core, options, requireContextWorkspaceRow.bind(null, writer), writeContextRow.bind(null, writer, core), {
          workspace_name: request.workspace_name,
          node_id: request.node_id,
          expected_revision_id: request.expected_revision_id,
          reason: request.reason,
          peer_name: request.peer_name,
          operation_id: request.operation_id,
          successor: null,
        }),
      );
}
