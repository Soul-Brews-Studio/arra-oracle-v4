/**
 * Barrel for bounded raw-transport helpers (`authorization-integration-v1.md`
 * §2, §5; #22 style-split4a). Each function moved VERBATIM to its own
 * `http.<fn>.ts` under `auth/`; shared types/data live in `http.types.ts`,
 * the shared `reject` helper in `http.reject.ts`. Re-exports here do not
 * count as function exports under the one-function-per-file ratchet.
 *
 * These run BEFORE any body is read. The route sets `parse: "none"` so the
 * framework performs no decoding of its own, and everything below operates on
 * the untouched request stream with an explicit byte ceiling.
 *
 * On header grammar: Bun's Fetch Request exposes headers AFTER comma-joining
 * duplicates, so this cannot count raw header lines. It is a post-flattening
 * fail-closed grammar gate — a comma-bearing value is rejected whether it came
 * from two header lines or one. That is deliberately weaker than a raw-wire
 * multiplicity proof and must not be described as one.
 */
export type { TransportRejection, RawBody } from "./http.types";
export { ERROR_BODIES } from "./http.types";
export { MAX_BODY_BYTES, readBoundedBody } from "./http.readBoundedBody";
export { readAuthorization } from "./http.readAuthorization";
export { checkHostAndOrigin } from "./http.checkHostAndOrigin";
export { checkBodyEncoding } from "./http.checkBodyEncoding";
export { isValidWorkspace } from "./http.isValidWorkspace";
export { isRejection } from "./http.isRejection";
export { errorResponse } from "./http.errorResponse";
