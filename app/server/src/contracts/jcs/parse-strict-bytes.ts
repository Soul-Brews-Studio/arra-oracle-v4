import { LIMITS } from "./constants";
import { decodeUtf8Strict } from "./decode-utf8-strict";
import { Parser, type SpanSink } from "./parser";
import type { JcsValue } from "./types";

/** Parse strict JSON bytes: byte cap, then fatal UTF-8, then grammar. */
export function parseStrictBytes(bytes: Uint8Array, tokens: Array<string | number> = [], opts: { maxDepth?: number; maxBytes?: number; onSpan?: SpanSink } = {}): JcsValue {
  const text = decodeUtf8Strict(bytes, opts.maxBytes ?? LIMITS.maxDocumentBytes, tokens);
  return new Parser(text, opts.maxDepth ?? LIMITS.maxDepth, tokens, opts.onSpan).parseDocument();
}
