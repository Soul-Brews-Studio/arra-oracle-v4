/**
 * Publication service error vocabulary — `arra-publication-error/v1`.
 *
 * A SEPARATE envelope from the governed `arra-error/v1` contract codec, and
 * deliberately so: these are persistence and state outcomes, not byte-contract
 * violations. Adding them to the protected closed codec would widen a frozen
 * error vocabulary that other slices already depend on.
 *
 * Split out of errors.ts (Nat style, one exported function per file —
 * docs/overnight/DECISIONS.md, slice style-server-split, 2026-09-28): this
 * module holds the shared vocabulary/class/message table (not itself a
 * function), consumed by errors.failPublication.ts and
 * errors.isContractError.ts.
 */

export const PUBLICATION_ERROR_VERSION = "arra-publication-error/v1" as const;

export const PUBLICATION_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "invalid_reference",
  "integrity_failure",
  "writer_unavailable",
  "unsupported_dataset",
  "recovery_required",
  "limit_exceeded",
  // #87 / R3 (docs/overnight/DECISIONS.md): the caller's own authority does
  // not cover this request -- a message read naming no requester without the
  // audit:read operator view, or a caller-asserted peer outside the grant's
  // arra-auth/v1 `peers` binding. HTTP 403. Appended, never reordered.
  "forbidden",
  // #32 / R9: no chat model is configured, or the configured one could not
  // produce an answer (unreachable, timed out, failed, empty). Nothing was
  // read wrongly and nothing was written; the caller did nothing wrong. HTTP
  // 503. Appended, never reordered.
  "model_unavailable",
  // #30 / R20: the embedding model digest measured for this embed run is
  // not the one this dataset's active profile was pinned to -- the same
  // model name now serves a different build. Nothing was embedded or
  // written; an operator must re-index under a new profile. HTTP 409.
  // Appended, never reordered.
  "embedding_profile_mismatch",
] as const;

export type PublicationErrorCode = (typeof PUBLICATION_ERROR_CODES)[number];

/** One fixed, safe message per code. Never interpolated, never caller text. */
export const MESSAGES: Readonly<Record<PublicationErrorCode, string>> = Object.freeze({
  invalid_request: "invalid publication request",
  not_found: "node not found",
  invalid_reference: "invalid scoped reference",
  integrity_failure: "stored state failed integrity validation",
  writer_unavailable: "dataset writer unavailable",
  unsupported_dataset: "unsupported target dataset",
  recovery_required: "writer recovery required",
  limit_exceeded: "publication limit exceeded",
  forbidden: "request not permitted for this caller",
  model_unavailable: "chat model unavailable",
  embedding_profile_mismatch: "embedding model digest differs from the dataset's pinned digest",
});

export type PublicationErrorShape = {
  version: typeof PUBLICATION_ERROR_VERSION;
  code: PublicationErrorCode;
  path: string;
  message: string;
};

export class PublicationError extends Error {
  readonly code!: PublicationErrorCode;
  readonly path!: string;

  /**
   * @param path RFC 6901 pointer. Read, state and owner errors use `""`;
   *             request and reference errors use their exact request pointer.
   */
  constructor(code: PublicationErrorCode, path = "") {
    super(MESSAGES[code]);
    this.name = "PublicationError";
    // Genuinely non-writable: `readonly` alone is erased at runtime, and a
    // caller must not be able to relabel an integrity failure as not_found.
    Object.defineProperty(this, "code", { value: code, writable: false, enumerable: true, configurable: false });
    Object.defineProperty(this, "path", { value: path, writable: false, enumerable: true, configurable: false });
  }

  toJSON(): PublicationErrorShape {
    return { version: PUBLICATION_ERROR_VERSION, code: this.code, path: this.path, message: this.message };
  }
}
