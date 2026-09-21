/**
 * Constants shared by more than one function in this directory. A constant
 * used by exactly one function lives in that function's own file instead --
 * see the module header comments there for which.
 */

/** 256 UTF-8 bytes. Shared by `name` (request grammar) and `storedName`
 *  (stored-row codec) -- the same bound applies on the way in and the way
 *  a stored row is read back. */
export const MAX_NAME_BYTES = 256;

/** Cumulative JSON UTF-8 budget for result-row arrays. A RESPONSE bound only:
 *  it implies nothing about Arrow allocation or process RSS. Exported for
 *  callers outside this directory (service.ts); no function here reads it. */
export const MAX_RESULT_WIRE_BYTES = 16 * 1024 * 1024;

/** Unreferenced in the original `context.ts` (declared, never called) --
 *  preserved as-is rather than dropped, since this is a pure move. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
