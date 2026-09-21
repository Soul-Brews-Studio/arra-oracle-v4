import type { JcsValue } from "../../contracts/jcs";
import { CREDENTIAL_KEYS } from "./constants";
import { closed } from "./closed";
import { field } from "./field";
import { requireBooleanValue } from "./require-boolean-value";
import { requireDigest } from "./require-digest";
import { requireId } from "./require-id";
import { requireTimestampMs } from "./require-timestamp-ms";
import type { CredentialRecord } from "./types";

export function parseCredential(value: JcsValue): CredentialRecord {
  const o = closed(value, CREDENTIAL_KEYS);
  const id = requireId(field(o, "id"));
  const principalId = requireId(field(o, "principal_id"));
  const digestHex = requireDigest(field(o, "sha256"));
  const notBeforeMs = requireTimestampMs(field(o, "not_before"));
  const expiresAtMs = requireTimestampMs(field(o, "expires_at"));
  const revoked = requireBooleanValue(field(o, "revoked"));
  return Object.freeze({ id, principalId, digestHex, notBeforeMs, expiresAtMs, revoked });
}
