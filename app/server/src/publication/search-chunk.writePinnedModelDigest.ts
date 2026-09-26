import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PINNED_DIGEST_FILE_NAME } from "./search-chunk.readPinnedModelDigest";

/**
 * Persist a freshly-measured embedding-model digest so every later boot
 * pins the SAME `profile_id` (see `search-chunk.readPinnedModelDigest.ts`'s
 * doc for why this exists).
 *
 * Best-effort, deliberately: a read-only or not-yet-existing dataset root
 * must never fail startup over a caching write. The active profile still
 * works correctly for the lifetime of THIS process either way -- only
 * cross-reboot identity stability is lost if the write fails, which is
 * exactly the pre-fix behaviour for every boot, not a new failure mode.
 */
export function writePinnedModelDigest(datasetRoot: string, model: string, digest: string): void {
  try {
    mkdirSync(datasetRoot, { recursive: true });
    writeFileSync(join(datasetRoot, PINNED_DIGEST_FILE_NAME), JSON.stringify({ model, digest }), "utf8");
  } catch {
    // Best-effort cache; see doc above.
  }
}
