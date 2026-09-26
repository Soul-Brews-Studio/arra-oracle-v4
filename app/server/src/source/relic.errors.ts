/**
 * `RelicAdapterError` -- internal-only. Nothing here crosses a transport, so
 * this is NOT the governed `arra-error/v1` codec (`contracts/errors.ts`) or
 * the publication codec (`publication/errors.ts`): a `SessionSource` is
 * consumed by trusted server code building evidence to pin, never directly
 * by a request handler (see the contract doc's "why internal" section), so
 * there is no wire shape to keep stable here.
 */

export const RELIC_ADAPTER_ERROR_CODES = [
  /** The binary could not be spawned at all (missing, not executable, ...). */
  "unavailable",
  /** The deadline in `RelicAdapterConfig.timeoutMs` was reached. */
  "timeout",
  /** Nonzero exit code. */
  "exit_nonzero",
  /** stdout exceeded `RelicAdapterConfig.maxOutputBytes`. */
  "output_too_large",
  /** stdout was not the JSON shape this adapter expects for the command run. */
  "bad_output",
  /** `read()`'s internal, read-only `session --no-index` resolve step found
   *  no exact-uuid, tier:"session" row -- e.g. a real session relic has not
   *  indexed yet. Reported as a typed refusal, never answered by falling
   *  back to a `tail` call that would risk relic's import-on-miss path. */
  "not_found",
] as const;

export type RelicAdapterErrorCode = (typeof RELIC_ADAPTER_ERROR_CODES)[number];

export class RelicAdapterError extends Error {
  readonly code: RelicAdapterErrorCode;

  constructor(code: RelicAdapterErrorCode, message: string) {
    super(message);
    this.name = "RelicAdapterError";
    this.code = code;
  }
}

export function failRelic(code: RelicAdapterErrorCode, message: string): never {
  throw new RelicAdapterError(code, message);
}
