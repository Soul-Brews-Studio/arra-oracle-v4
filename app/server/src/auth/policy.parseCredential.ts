import type { JcsValue } from "../contracts/jcs";
import { CREDENTIAL_KEYS } from "./policy.constants";
import { closed } from "./policy.closed";
import { field } from "./policy.field";
import { requireBooleanValue } from "./policy.requireBooleanValue";
import { requireDigest } from "./policy.requireDigest";
import { requireId } from "./policy.requireId";
import { requireTimestampMs } from "./policy.requireTimestampMs";
import type { CredentialRecord } from "./policy.types";

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
