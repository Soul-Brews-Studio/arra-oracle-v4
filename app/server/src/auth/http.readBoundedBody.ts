import type { RawBody } from "./http.types";
import { reject } from "./http.reject";

export const MAX_BODY_BYTES = 256 * 1024;
/** Read one byte past the cap so cap and cap+1 are distinguishable. */
const READ_CEILING = MAX_BODY_BYTES + 1;

/**
 * Read at most MAX_BODY_BYTES from the untouched stream, cancelling as soon as
 * the ceiling is passed rather than buffering the whole message first.
 *
 * One runtime-delivered chunk may transiently exceed the cap; this bounds what
 * is RETAINED and stops reading promptly. It is not a process-memory sandbox.
 */
export async function readBoundedBody(request: Request): Promise<RawBody> {
  const stream = request.body;
  if (stream === null) return { bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return reject(413, "payload too large");
      }
      chunks.push(value);
      if (total > READ_CEILING) break;
    }
  } catch {
    return reject(400, "malformed request");
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}
