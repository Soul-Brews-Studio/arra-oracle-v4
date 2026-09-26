import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failPublication } from "./errors";
import { failEmbeddingProfileMismatch } from "./search-chunk.failEmbeddingProfileMismatch";
import { EMBEDDING_PINS_FILE_NAME, EMBEDDING_PINS_VERSION, readEmbeddingPins } from "./search-chunk.readEmbeddingPins";

/**
 * Pin `digest` as `profileId`'s model identity for this dataset (R20).
 * Called by `embedPendingChunks` inside its `core.serial` turn, after every
 * precondition and immediately before the FIRST vector write of a run that
 * has no pin yet, with the digest that same run measured.
 *
 * Never overwrites: an existing pin with the same digest is a no-op, an
 * existing DIFFERENT pin is `embedding_profile_mismatch` (re-pinning is an
 * operator's deliberate re-index, not something a run does).
 *
 * Atomic (a sibling temp file, then `rename`), so a crash never leaves a
 * half-written pin for `readEmbeddingPins` to refuse. Deliberately NO
 * `mkdir`: the root is an already-open dataset by the time this runs, and a
 * missing directory must fail, not be created (fix round 2: the boot-time
 * version created a mistyped `ARRA_KNOWLEDGE_DATASET_ROOT` on disk). A
 * failed write is `writer_unavailable` and the caller writes no vector.
 */
export function writeEmbeddingPin(datasetRoot: string, profileId: string, digest: string, pinnedAtMs: number): void {
  const pins = readEmbeddingPins(datasetRoot);
  const existing = Object.hasOwn(pins, profileId) ? pins[profileId]! : null;
  if (existing !== null) {
    if (existing.digest !== digest) failEmbeddingProfileMismatch(existing.digest, digest);
    return;
  }
  const next = { ...pins, [profileId]: { digest, pinned_at: new Date(pinnedAtMs).toISOString() } };
  const path = join(datasetRoot, EMBEDDING_PINS_FILE_NAME);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: EMBEDDING_PINS_VERSION, pins: next }), { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best effort: the pin itself was not written either way.
    }
    failPublication("writer_unavailable");
  }
}
