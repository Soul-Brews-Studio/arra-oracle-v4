import { ContractError, fail } from "./errors";
import { requireClosedObject, requireNanoid21, requireNonemptyString, requireSha256Hex } from "./common";
import type { JcsObject, JcsValue } from "./jcs";
import { sourceReplayOp } from "./replay-v1";
import { get } from "./source-ingestion-v1.get";
import { parseRoot } from "./source-ingestion-v1.parseRoot";

const REQUESTED_KEYS = ["workspace_name", "session_name"] as const;
const INCOMING_KEYS = ["source_namespace", "source_message_id", "source_payload_digest"] as const;
const EXISTING_KEYS = ["workspace_name", "session_name", "source_namespace", "source_message_id", "source_payload_digest", "public_id"] as const;

/** Helper field names differ from ours; translate paths back so callers never see them. */
const HELPER_PATH_RENAMES: Array<[RegExp, string]> = [
  [/\/content_digest$/, "/source_payload_digest"],
  [/\/message_public_id$/, "/public_id"],
];

// ---------------------------------------------------------------------------
// 8.4 classifyMessageDestinationReplay
// ---------------------------------------------------------------------------

export function classifyMessageDestinationReplay(json: unknown): { outcome: string; original_id: string | null } {
  const root = requireClosedObject(parseRoot(json), ["requested", "incoming", "existing"], []);

  const requested = requireClosedObject(get(root, "requested"), REQUESTED_KEYS, ["requested"]);
  const reqWorkspace = requireNonemptyString(get(requested, "workspace_name"), ["requested", "workspace_name"]);
  const reqSession = requireNonemptyString(get(requested, "session_name"), ["requested", "session_name"]);

  const incoming = requireClosedObject(get(root, "incoming"), INCOMING_KEYS, ["incoming"]);
  const incNamespace = requireNonemptyString(get(incoming, "source_namespace"), ["incoming", "source_namespace"]);
  const incMessageId = requireNonemptyString(get(incoming, "source_message_id"), ["incoming", "source_message_id"]);
  const incDigest = requireSha256Hex(get(incoming, "source_payload_digest"), ["incoming", "source_payload_digest"]);

  const rawExisting = get(root, "existing");
  let existing: JcsObject | null = null;
  let exWorkspace = "", exSession = "", exNamespace = "", exMessageId = "", exDigest = "", exPublicId = "";
  if (rawExisting !== null) {
    existing = requireClosedObject(rawExisting, EXISTING_KEYS, ["existing"]);
    exWorkspace = requireNonemptyString(get(existing, "workspace_name"), ["existing", "workspace_name"]);
    exSession = requireNonemptyString(get(existing, "session_name"), ["existing", "session_name"]);
    exNamespace = requireNonemptyString(get(existing, "source_namespace"), ["existing", "source_namespace"]);
    exMessageId = requireNonemptyString(get(existing, "source_message_id"), ["existing", "source_message_id"]);
    exDigest = requireSha256Hex(get(existing, "source_payload_digest"), ["existing", "source_payload_digest"]);
    exPublicId = requireNanoid21(get(existing, "public_id"), ["existing", "public_id"]);
  }

  // ---- destination BEFORE namespace/ID/digest. The replay tuple has no
  // session, so a different destination is a scope error, not permission to
  // duplicate or move the message. ----
  if (existing !== null) {
    if (exWorkspace !== reqWorkspace) fail("scope_mismatch", ["existing", "workspace_name"], "existing message is in a different workspace");
    if (exSession !== reqSession) fail("scope_mismatch", ["existing", "session_name"], "existing message is in a different session");
  }

  // Project into the UNCHANGED accepted classifier: requested workspace becomes
  // the incoming workspace, the digest is renamed, the public id is renamed,
  // and session is omitted from that helper's closed shape.
  try {
    return sourceReplayOp(
      new Map<string, JcsValue>([
        ["workspace_name", reqWorkspace],
        ["source_namespace", incNamespace],
        ["source_message_id", incMessageId],
        ["content_digest", incDigest],
      ]),
      existing === null
        ? null
        : new Map<string, JcsValue>([
            ["workspace_name", exWorkspace],
            ["source_namespace", exNamespace],
            ["source_message_id", exMessageId],
            ["content_digest", exDigest],
            ["message_public_id", exPublicId],
          ]),
    );
  } catch (error) {
    // Re-anchor the helper's paths onto this wrapper's actual input field names.
    if (error instanceof ContractError) {
      let path = error.path;
      for (const [pattern, replacement] of HELPER_PATH_RENAMES) path = path.replace(pattern, replacement);
      throw new ContractError(error.code, path, error.message);
    }
    throw error;
  }
}
