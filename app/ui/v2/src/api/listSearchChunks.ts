import { callMethod } from "./client";
import type { Bank } from "./memory";

/** `search-chunk.chunkerVersion.ts` CHUNKER_VERSION -- the ONLY chunker the
 *  server implements; `parseListChunks` refuses any other label, so this is a
 *  constant and not a setting (the same footing as SCHEMA_VERSION). */
export const CHUNKER_VERSION = "chunker/v1";

/** The columns of one `listSearchChunks` row this UI reads: its embedding
 *  state. The row carries more (text, content_hash, term_ids, ...). */
export type SearchChunkStatusRow = {
  status: "pending" | "ready" | "failed";
  attempts: string;
  error_code: string | null;
  last_attempt_at: string | null;
};

/** One revision's chunks under one embedding profile (`content:read`). */
export function listSearchChunks(b: Bank, revision_id: string, embedding_profile: string) {
  return callMethod(
    b.bank,
    "listSearchChunks",
    { workspace_name: b.workspace, revision_id, chunker_version: CHUNKER_VERSION, embedding_profile },
    b.token,
  );
}
