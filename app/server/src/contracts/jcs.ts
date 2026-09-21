/**
 * Strict JSON parsing and RFC 8785 (JCS) canonicalization — the one byte path.
 *
 * Why a hand-written parser: native `JSON.parse` silently keeps the LAST of
 * two duplicate keys and cannot report nesting depth, so anything built on it
 * has already lost the evidence the contract requires us to reject on. This
 * parser enforces duplicate DECODED keys, depth, and surrogate validity while
 * it walks the text, and returns objects as `Map`s so key order is explicit
 * and nothing inherits from `Object.prototype`.
 *
 * Numbers are ordinary IEEE-754 binary64 (I-JSON §2.2): decimals are fine,
 * integer literals past 2^53 round exactly as ECMAScript rounds them, and
 * anything needing exact arbitrary precision must be a string. Serialization
 * follows ECMAScript Number::toString, which is what JCS specifies; `-0`
 * becomes `0`.
 *
 * Contract: app/docs/contracts/revision-evidence-v1.md §2.
 *
 * This file is a thin barrel: the implementation lives in `./jcs/`, split one
 * function per file. Canonicalization is cryptographically load-bearing
 * (contract digests are computed over `canonicalize`'s output), so every
 * function below was moved BYTE-FOR-BYTE — no reformatting, no reordering of
 * operations, no renamed locals. See `./jcs/` for the actual logic.
 */

export { LIMITS } from "./jcs/constants";
export type { JcsObject, JcsValue } from "./jcs/types";
export { utf8ByteLength } from "./jcs/utf8-byte-length";
export { decodeUtf8Strict } from "./jcs/decode-utf8-strict";
export { hasOnlyPairedSurrogates } from "./jcs/has-only-paired-surrogates";
export type { SpanSink } from "./jcs/parser";
export { parseStrict } from "./jcs/parse-strict";
export { parseStrictBytes } from "./jcs/parse-strict-bytes";
export { parseObjectText } from "./jcs/parse-object-text";
export { canonicalNumber } from "./jcs/canonical-number";
export { canonicalString } from "./jcs/canonical-string";
export { compareUtf16 } from "./jcs/compare-utf16";
export { canonicalize } from "./jcs/canonicalize";
export { canonicalizeText } from "./jcs/canonicalize-text";
export { canonicalBytes } from "./jcs/canonical-bytes";
export { jsonByteLength } from "./jcs/json-byte-length";
export { jcsEqual } from "./jcs/jcs-equal";
export { obj } from "./jcs/obj";

export { ContractError, pointer, reanchor } from "./errors";
