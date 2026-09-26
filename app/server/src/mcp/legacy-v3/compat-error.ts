/**
 * The `arra-v3-compat/1` refusal (docs/overnight/V3-PARITY.md §2.6).
 *
 * v3 clients read `{success:false, error}` and print `Error: <msg>`, so
 * `error` carries v3-style text. `compat` says, in a closed code set, WHY v4
 * answered differently; `v4_error` carries a wrapped v4 envelope unchanged
 * (only for `kernel_error`).
 *
 * It travels as a thrown error with string `code` and `path` and a `toJSON`,
 * which is exactly the shape `auth/service.ts` `runMcp` already passes
 * through as exact JSON with `isError:true` and an audit row `status:"error"`.
 */

export const COMPAT_VERSION = "arra-v3-compat/1";

export type CompatCode =
  | "not_carried"
  | "not_yet_available"
  | "legacy_id_unknown"
  | "speaker_required"
  | "unsupported_argument"
  | "semantic_refusal"
  | "no_results"
  | "kernel_error";

export class CompatError extends Error {
  readonly code: CompatCode;
  /** JSON pointer into the caller's arguments; "" when no argument is at fault. */
  readonly path: string;
  readonly tool: string;
  readonly detail: string;
  readonly v4Error: unknown;

  constructor(tool: string, code: CompatCode, error: string, detail: string, options: { path?: string; v4Error?: unknown } = {}) {
    super(error);
    this.name = "CompatError";
    this.tool = tool;
    this.code = code;
    this.detail = detail;
    this.path = options.path ?? "";
    this.v4Error = options.v4Error ?? null;
  }

  toJSON() {
    return {
      success: false,
      error: this.message,
      compat: {
        version: COMPAT_VERSION,
        code: this.code,
        tool: this.tool,
        ...(this.path === "" ? {} : { path: this.path }),
        detail: this.detail,
      },
      v4_error: this.v4Error,
    };
  }
}
