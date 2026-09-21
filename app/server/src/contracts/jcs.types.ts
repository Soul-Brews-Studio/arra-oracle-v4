/**
 * Shared value types for strict JSON parsing and RFC 8785 (JCS)
 * canonicalization. Split out because nearly every function in this
 * directory takes or returns a `JcsValue`/`JcsObject`.
 */

export type JcsValue = null | boolean | number | string | JcsValue[] | JcsObject;
export type JcsObject = Map<string, JcsValue>;
