import { openCallLogTable } from "./calls.openCallLogTable";
import { recordableName } from "./calls.recordableName";
import { truncate } from "./calls.truncate";
import { auditFailuresState } from "./calls.state";

/** Non-secret authenticated attribution. Never a token, digest or header. */
export interface AuditAttribution {
  principal_id: string;
  credential_id: string;
  policy_version: string;
}

export interface CallRecord {
  tool: string;
  input: unknown;
  status: "ok" | "error";
  result: unknown;
  duration_ms: number;
  workspace_name: string;
  /**
   * DOMAIN field: the registered peer who authored the content, or null. The
   * authenticated principal must NEVER be written here -- it travels in `auth`
   * below, because overloading this column would silently redefine authorship.
   */
  peer_name?: string | null;
  session_name?: string | null;
  client_label?: string | null;
  /** D6 (R18): the `arra_*` alias the caller used; `tool` is then its canonical name. */
  requested_as?: string | null;
  /** Present for admitted operations; absent only for legacy internal writes. */
  auth?: AuditAttribution | null;
}

export async function logCall(rec: CallRecord): Promise<void> {
  try {
    // #103 fix round 2: caller-supplied NAME columns are recorded only in the
    // form the reader's codec accepts -- see `calls.recordableName.ts`. The
    // other columns need no such step: `workspace_name` is the admitted
    // policy scope, `tool` is a catalogue name (`auth/service.createOperationService.ts` audits no
    // unknown tool), and both metadata columns are `JSON.stringify` output,
    // which is always well-formed text.
    const session = recordableName(rec.session_name);
    const peer = recordableName(rec.peer_name);
    const invalidFields = [
      ...(session.invalid ? ["session_name"] : []),
      ...(peer.invalid ? ["peer_name"] : []),
    ];
    const tbl = await openCallLogTable();
    await tbl.add([
      {
        id: `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        workspace_name: rec.workspace_name,
        session_name: session.value,
        peer_name: peer.value,
        tool: rec.tool,
        status: rec.status,
        duration_ms: rec.duration_ms,
        // A FRESH wrapper-owned object every time: caller metadata is never
        // merged in, so a caller cannot forge or overwrite the auth block --
        // or the `invalid_fields` flag, which is present only when a name
        // column above was recorded as null INSTEAD of what was sent.
        h_metadata: JSON.stringify({
          input: truncate(rec.input),
          result: truncate(rec.result),
          // v3 adapter (R18 D6): the alias the caller actually named, e.g. arra_search.
          ...(rec.requested_as ? { requested_as: rec.requested_as } : {}),
          ...(rec.auth
            ? {
                auth: {
                  principal_id: rec.auth.principal_id,
                  credential_id: rec.auth.credential_id,
                  policy_version: rec.auth.policy_version,
                },
              }
            : {}),
          ...(invalidFields.length > 0 ? { invalid_fields: invalidFields } : {}),
        }),
        internal_metadata: rec.client_label
          ? JSON.stringify({ transport: { user_agent: truncate(rec.client_label) } })
          : null,
        created_at: Date.now(),
      },
    ]);
  } catch {
    // Best-effort, and deliberately NOT transactional with the operation it
    // audits: that operation already happened and is not rolled back here.
    // Only a fixed sanitized marker is emitted, never raw exception text,
    // which could carry store internals into the logs.
    auditFailuresState.count += 1;
    console.error("[call_log] audit_write_failed");
  }
}
