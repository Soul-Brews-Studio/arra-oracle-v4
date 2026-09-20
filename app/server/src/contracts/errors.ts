/**
 * Closed, transport-neutral contract errors — `arra-error/v1`.
 *
 * Every rejection in this package is one of these. `path` is an RFC 6901 JSON
 * Pointer, empty string for the root, with `~` and `/` escaped as `~0`/`~1`.
 * Tests assert codes and paths, never prose.
 */

export const ERROR_VERSION = "arra-error/v1" as const;

export const ERROR_CODES = [
  "invalid_json",
  "duplicate_key",
  "invalid_unicode",
  "invalid_type",
  "missing_field",
  "unexpected_field",
  "invalid_value",
  "out_of_range",
  "limit_exceeded",
  "unsupported_version",
  "snapshot_position",
  "digest_mismatch",
  "target_key_mismatch",
  "scope_mismatch",
  "worker_failure",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ContractErrorShape = {
  version: typeof ERROR_VERSION;
  code: ErrorCode;
  path: string;
  message: string;
};

/** Escape one JSON Pointer reference token (RFC 6901 §3). Order matters: `~` first. */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Build a pointer from already-unescaped tokens. `[]` is the root, `""`. */
export function pointer(tokens: Array<string | number>): string {
  if (tokens.length === 0) return "";
  return "/" + tokens.map((t) => escapePointerToken(String(t))).join("/");
}

export class ContractError extends Error {
  readonly code: ErrorCode;
  readonly path: string;

  constructor(code: ErrorCode, path: string, message: string) {
    super(message);
    this.name = "ContractError";
    this.code = code;
    this.path = path;
  }

  toJSON(): ContractErrorShape {
    return { version: ERROR_VERSION, code: this.code, path: this.path, message: this.message };
  }
}

export function fail(code: ErrorCode, tokens: Array<string | number>, message: string): never {
  throw new ContractError(code, pointer(tokens), message);
}

/** Re-anchor an error raised deeper in the tree under a parent path prefix. */
export function reanchor(error: unknown, prefix: Array<string | number>): never {
  if (error instanceof ContractError) {
    const suffix = error.path;
    throw new ContractError(error.code, pointer(prefix) + suffix, error.message);
  }
  throw error;
}
