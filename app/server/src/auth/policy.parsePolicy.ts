import { parseStrictBytes } from "../contracts/jcs";
import { MAX_CREDENTIALS, MAX_DEPTH, MAX_DOCUMENT_BYTES, MAX_PRINCIPALS, POLICY_VERSION, ROOT_KEYS } from "./policy.constants";
import { closed } from "./policy.closed";
import { field } from "./policy.field";
import { hasDuplicate } from "./policy.hasDuplicate";
import { opaque } from "./policy.opaque";
import { parseCredential } from "./policy.parseCredential";
import { parsePrincipal } from "./policy.parsePrincipal";
import { registerPolicy } from "./policy.registry";
import { reject } from "./policy.reject";
import { requireArrayValue } from "./policy.requireArrayValue";
import type { Policy, PolicyRecord, PrincipalRecord } from "./policy.types";

const NO_TOKENS: Array<string | number> = [];

/**
 * Validate a complete policy document and return an opaque frozen snapshot.
 *
 * Order is fixed by contract: original byte cap, fatal UTF-8 decode, strict
 * JSON with duplicate-key and depth rejection, root shape, principals in array
 * order, credentials in array order, then uniqueness, references and times.
 */
export function parsePolicy(raw: Uint8Array): Policy {
  // `instanceof` alone would accept a Buffer, which is fine, but a DataView or
  // ArrayBuffer is not a byte array and must not be coerced into one.
  if (!(raw instanceof Uint8Array)) reject("policy_invalid");

  // Byte cap and fatal UTF-8 both happen inside the shared strict parser, in
  // that order, against the ORIGINAL bytes -- never against a re-encoding.
  const document = opaque(
    () => parseStrictBytes(raw, NO_TOKENS, { maxBytes: MAX_DOCUMENT_BYTES, maxDepth: MAX_DEPTH }),
    "policy_invalid",
  );

  const root = closed(document, ROOT_KEYS);
  if (field(root, "version") !== POLICY_VERSION) reject("policy_invalid");

  const rawPrincipals = requireArrayValue(field(root, "principals"));
  if (rawPrincipals.length > MAX_PRINCIPALS) reject("policy_invalid");
  const principals = rawPrincipals.map(parsePrincipal);

  const rawCredentials = requireArrayValue(field(root, "credentials"));
  if (rawCredentials.length > MAX_CREDENTIALS) reject("policy_invalid");
  const credentials = rawCredentials.map(parseCredential);

  // Cross-cutting checks, in contract order, after every shape and value passed.
  if (hasDuplicate(principals.map((p) => p.id))) reject("policy_invalid");
  for (const principal of principals) {
    if (hasDuplicate(principal.workspaces.map((w) => w.name))) reject("policy_invalid");
    for (const w of principal.workspaces) {
      if (hasDuplicate(w.actions)) reject("policy_invalid");
    }
    if (hasDuplicate(principal.globalActions)) reject("policy_invalid");
  }
  if (hasDuplicate(credentials.map((c) => c.id))) reject("policy_invalid");
  if (hasDuplicate(credentials.map((c) => c.digestHex))) reject("policy_invalid");

  const principalsById: Record<string, PrincipalRecord> = Object.create(null);
  for (const principal of principals) principalsById[principal.id] = principal;
  Object.freeze(principalsById);
  for (const credential of credentials) {
    if (!Object.hasOwn(principalsById, credential.principalId)) reject("policy_invalid");
  }
  for (const credential of credentials) {
    if (!(credential.notBeforeMs < credential.expiresAtMs)) reject("policy_invalid");
  }

  const record: PolicyRecord = Object.freeze({
    version: POLICY_VERSION,
    principalsById,
    credentials: Object.freeze(credentials),
  });

  // The handle carries no data at all; everything lives in the private map.
  const handle = Object.freeze(Object.create(null)) as Policy;
  registerPolicy(handle, record);
  return handle;
}
