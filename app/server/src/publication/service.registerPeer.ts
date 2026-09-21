import { type ChatModelFn } from "./chat";
import { PEER_FIELDS as PEER_FIELDS_LOCAL, encodePeerRow, parseRegisterPeer } from "./context";
import { PEERS } from "./service.constants";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { registerNamed } from "./service.registerNamed";
import { type Clock, type ContextRegistration, type DatasetAdapter, type OwnerCore } from "./service.types";

export function registerPeer(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null; model?: ChatModelFn }, requestBytes: Uint8Array): Promise<ContextRegistration> {
return mutateContextWrite(core, async () => {
        const request = parseRegisterPeer(requestBytes);
        return registerNamed(writer, core, options, 
          PEERS,
          request.workspace_name,
          request.peer_id,
          request.name,
          (created_at) => ({
            id: request.peer_id,
            name: request.name,
            workspace_name: request.workspace_name,
            // New optional fields are null. Peers are NEVER merged by display
            // metadata or label resemblance.
            h_metadata: null,
            internal_metadata: null,
            configuration: null,
            created_at,
          }),
          encodePeerRow,
          PEER_FIELDS_LOCAL,
        );
      });
}
