import { utf8 } from "./codecs";

export function utf8ByteLength(text: string): number {
  return utf8.encode(text).byteLength;
}
