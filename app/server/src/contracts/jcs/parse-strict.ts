import { fail } from "../errors";
import { LIMITS } from "./constants";
import { hasOnlyPairedSurrogates } from "./has-only-paired-surrogates";
import { Parser, type SpanSink } from "./parser";
import type { JcsValue } from "./types";
import { utf8ByteLength } from "./utf8-byte-length";

/**
 * Parse strict JSON text. `tokens` is the JSON Pointer prefix errors are
 * reported under (the location of THIS document inside a larger payload).
 */
export function parseStrict(text: string, tokens: Array<string | number> = [], opts: { maxDepth?: number; maxBytes?: number; onSpan?: SpanSink } = {}): JcsValue {
  const maxBytes = opts.maxBytes ?? LIMITS.maxDocumentBytes;
  const size = utf8ByteLength(text);
  if (size > maxBytes) fail("limit_exceeded", tokens, `document is ${size} bytes; limit ${maxBytes}`);
  if (!hasOnlyPairedSurrogates(text)) fail("invalid_unicode", tokens, "unpaired surrogate in document");
  return new Parser(text, opts.maxDepth ?? LIMITS.maxDepth, tokens, opts.onSpan).parseDocument();
}
