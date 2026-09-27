import { callMethod } from "./client";
import type { Bank } from "./memory";

/** `service.getSearchFreshness.ts` SearchFreshness, as it crosses the wire.
 *  WORKSPACE-wide: the method takes only `workspace_name`, so nothing here is
 *  about one node. `null` means unknown, never zero (search-chunk-v1 §B). */
export type SearchFreshness = {
  content: { nodes: number; revisions: number };
  text_index: { indexed_rows: number | null; unindexed_rows: number | null };
  vectors: {
    profile_id: string;
    pending: number;
    ready: number;
    failed: number;
    last_attempt_at: string | null;
    model_digest: { pinned: string | null; last_measured: string | null };
  };
};

/** #30 freshness per stage for the workspace (`content:read`). */
export function getSearchFreshness(b: Bank) {
  return callMethod(b.bank, "getSearchFreshness", { workspace_name: b.workspace }, b.token);
}
