import { failPublication } from "./errors";
import { utf8ByteLength } from "./rows";

export function requireWorkspaceName(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) failPublication("invalid_request", path);
  if (utf8ByteLength(value) > 256) failPublication("invalid_request", path);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) failPublication("invalid_request", path);
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      failPublication("invalid_request", path);
    }
  }
  return value;
}
