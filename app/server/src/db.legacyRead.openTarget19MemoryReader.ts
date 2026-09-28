import { composeKnowledgeAccess } from "./composition.composeKnowledgeAccess";
import { target19ReaderState } from "./db.legacyRead.state";
import { type KnowledgeReaderBundle } from "./knowledge/registry";

/**
 * Lazily opens, then caches for the process lifetime, the target-19 READER
 * bundle behind the S2 legacy-shaped read path (`db.legacyRead.*`). Same
 * lazy-open/cache-forever discipline as `transport.createKnowledgeAccess.ts`'s
 * own reader: reads are gateless and cheap to reopen, but a fresh bundle per
 * call would reopen the LanceDB connection on every legacy-shaped request.
 *
 * `getBundle("content:read")` (a non-write action) always answers the reader
 * bundle (`transport.createKnowledgeAccess.ts`'s own branch on `action`), so
 * this is cast to `KnowledgeReaderBundle`, exactly as `knowledge/registry.ts`'s
 * `searches()`/`chat()` backstops assume for every `content:read` method.
 */
export async function openTarget19MemoryReader(env: NodeJS.ProcessEnv = process.env): Promise<KnowledgeReaderBundle> {
  target19ReaderState.cached ??= composeKnowledgeAccess(env).then(
    (access) => access.getBundle("content:read") as Promise<KnowledgeReaderBundle>,
  );
  return target19ReaderState.cached;
}
