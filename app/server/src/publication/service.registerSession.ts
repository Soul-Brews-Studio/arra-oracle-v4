import { SESSION_FIELDS as SESSION_FIELDS_LOCAL, encodeSessionRow, parseRegisterSession } from "./context";
import { SESSIONS } from "./service.constants";
import { mutateContextWrite } from "./service.mutateContextWrite";
import { registerNamed } from "./service.registerNamed";
import { type Clock, type ContextRegistration, type DatasetAdapter, type OwnerCore } from "./service.types";

export function registerSession(writer: DatasetAdapter, core: OwnerCore, options: { clock: Clock; sourceNamespace: string | null }, requestBytes: Uint8Array): Promise<ContextRegistration> {
return mutateContextWrite(core, async () => {
        const request = parseRegisterSession(requestBytes);
        return registerNamed(writer, core, options, 
          SESSIONS,
          request.workspace_name,
          request.session_id,
          request.name,
          (created_at) => ({
            id: request.session_id,
            name: request.name,
            workspace_name: request.workspace_name,
            is_active: true,
            h_metadata: null,
            internal_metadata: null,
            configuration: null,
            created_at,
          }),
          encodeSessionRow,
          SESSION_FIELDS_LOCAL,
        );
      });
}
