import { canonicalize } from "./canonicalize";
import { utf8 } from "./codecs";
import type { JcsValue } from "./types";

export function canonicalBytes(value: JcsValue, tokens: Array<string | number> = []): Uint8Array {
  return utf8.encode(canonicalize(value, tokens));
}
