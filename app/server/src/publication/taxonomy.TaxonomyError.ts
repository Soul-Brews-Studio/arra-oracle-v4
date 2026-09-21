export const TAXONOMY_ERROR_VERSION = "arra-taxonomy-error/v1" as const;

export const TAXONOMY_ERROR_CODES = [
  "invalid_request",
  "not_found",
  "invalid_reference",
  "conflict",
  "integrity_failure",
  "writer_unavailable",
  "unsupported_dataset",
  "recovery_required",
  "limit_exceeded",
] as const;

export type TaxonomyErrorCode = (typeof TAXONOMY_ERROR_CODES)[number];

/** One fixed, safe message per code. Never interpolated, never caller text. */
const MESSAGES: Readonly<Record<TaxonomyErrorCode, string>> = Object.freeze({
  invalid_request: "invalid taxonomy request",
  not_found: "taxonomy row not found",
  invalid_reference: "invalid scoped reference",
  conflict: "taxonomy state conflict",
  integrity_failure: "stored state failed integrity validation",
  writer_unavailable: "dataset writer unavailable",
  unsupported_dataset: "unsupported target dataset",
  recovery_required: "writer recovery required",
  limit_exceeded: "taxonomy limit exceeded",
});

export type TaxonomyErrorShape = {
  version: typeof TAXONOMY_ERROR_VERSION;
  code: TaxonomyErrorCode;
  path: string;
  message: string;
};

/**
 * A SEPARATE envelope from `arra-publication-error/v1`.
 *
 * Deliberately separate: unlike publication, taxonomy conflicts are THROWN
 * safe errors rather than returned outcome objects, so sharing one class
 * would blur two different caller contracts.
 */
export class TaxonomyError extends Error {
  readonly code!: TaxonomyErrorCode;
  readonly path!: string;

  constructor(code: TaxonomyErrorCode, path = "") {
    super(MESSAGES[code]);
    this.name = "TaxonomyError";
    // Genuinely non-writable: `readonly` is erased at runtime, and a caller
    // must not be able to relabel an integrity failure as a not_found.
    Object.defineProperty(this, "code", { value: code, writable: false, enumerable: true, configurable: false });
    Object.defineProperty(this, "path", { value: path, writable: false, enumerable: true, configurable: false });
  }

  toJSON(): TaxonomyErrorShape {
    return { version: TAXONOMY_ERROR_VERSION, code: this.code, path: this.path, message: this.message };
  }
}
