/**
 * Publication service errors — `arra-publication-error/v1`.
 *
 * A SEPARATE envelope from the governed `arra-error/v1` contract codec, and
 * deliberately so: these are persistence and state outcomes, not byte-contract
 * violations. Adding them to the protected closed codec would widen a frozen
 * error vocabulary that other slices already depend on.
 *
 * Strict-parse, closed-object and governed-codec failures keep their ORIGINAL
 * `arra-error/v1` code, path and envelope and pass through untouched. Only
 * publication semantics use the codes below.
 *
 * Messages are fixed literals. A caught exception's text could carry a dataset
 * path, a row excerpt or an SDK internal, so none of it is ever surfaced.
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
] as const;

export type PublicationErrorCode = (typeof PUBLICATION_ERROR_CODES)[number];

/** One fixed, safe message per code. Never interpolated, never caller text. */
const MESSAGES: Readonly<Record<PublicationErrorCode, string>> = Object.freeze({
  invalid_request: "invalid publication request",
  not_found: "node not found",
  invalid_reference: "invalid scoped reference",
  integrity_failure: "stored state failed integrity validation",
  writer_unavailable: "dataset writer unavailable",
  unsupported_dataset: "unsupported target dataset",
  recovery_required: "writer recovery required",
  limit_exceeded: "publication limit exceeded",
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

export function failPublication(code: PublicationErrorCode, path = ""): never {
  throw new PublicationError(code, path);
}

/** True for the governed contract errors, which must pass through unchanged. */
export function isContractError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ContractError"
  );
}
