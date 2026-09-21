/** Shared by more than one function in this kernel -- kept here rather than
 *  duplicated or attached to a single caller. */

/** Shared by `nullableShortText` and `parseCreateTrace`'s own `name` field
 *  bound. */
export const MAX_SHORT_TEXT_BYTES = 256;

/* Gregorian bounds shared by `millisToTimestamp` and `timestampToMillis`.
 * Duplicated from `./rows` because that module does not export them, and
 * importing a private constant is not an option. */
export const MIN_EPOCH_MS = -62135596800000n;
export const MAX_EPOCH_MS = 253402300799999n;
