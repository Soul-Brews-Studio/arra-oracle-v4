// Split from transport.ts (style-split4b, 2026-09-28).
import { MAX_KNOWLEDGE_REQUEST_BYTES, type RawBody } from "./transport.state";

const READ_CEILING = MAX_KNOWLEDGE_REQUEST_BYTES + 1;

/**
 * Read at most `MAX_KNOWLEDGE_REQUEST_BYTES` from the untouched stream.
 *
 * Deliberately separate from `auth/http.ts`'s `readBoundedBody`: that one is
 * pinned to the #25 memories contract's 256 KiB route cap, which is smaller
 * than the 1 MiB this kernel's own governed parser already allows. Reusing
 * it here would silently shrink the knowledge contract to a cap it never
 * declared.
 */
export async function readKnowledgeBody(request: Request): Promise<RawBody> {
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
      if (total > MAX_KNOWLEDGE_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: 413, error: "payload too large" };
      }
      chunks.push(value);
      if (total > READ_CEILING) break;
    }
  } catch {
    return { status: 400, error: "malformed request" };
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
