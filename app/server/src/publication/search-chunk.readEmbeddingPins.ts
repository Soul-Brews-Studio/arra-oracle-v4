import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { failPublication } from "./errors";
import { MODEL_DIGEST_PATTERN } from "./search-chunk.fetchOllamaModelDigest";

/**
 * R20's per-dataset pin record: one small JSON file directly under the
 * knowledge dataset root, NOT a LanceDB table (Python owns that schema, per
 * this repo's split). Keyed by `profile_id`, so changing `EMBEDDING_MODEL`
 * starts a separate pin instead of overwriting the old profile's one.
 * `search-chunk.writeEmbeddingPin.ts` is its only writer.
 */
export const EMBEDDING_PINS_FILE_NAME = ".embedding-profile-pins.json";
export const EMBEDDING_PINS_VERSION = "arra-embedding-pins/v1";

export type EmbeddingPin = { digest: string; pinned_at: string };

/**
 * Every pin this dataset holds, by `profile_id`. An absent file is "nothing
 * pinned yet" (`{}`). A file that exists but cannot be read, is not the
 * versioned shape, or holds a digest outside `MODEL_DIGEST_PATTERN` is
 * `integrity_failure`, never "not pinned": reading a damaged pin as absent
 * would let the next embed run pin whatever model is serving now, which is
 * exactly the silent mix R20 forbids.
 */
export function readEmbeddingPins(datasetRoot: string): Record<string, EmbeddingPin> {
  const path = join(datasetRoot, EMBEDDING_PINS_FILE_NAME);
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    failPublication("integrity_failure");
  }
  const document = parsed as { version?: unknown; pins?: unknown } | null;
  if (
    typeof document !== "object" || document === null ||
    document.version !== EMBEDDING_PINS_VERSION ||
    typeof document.pins !== "object" || document.pins === null || Array.isArray(document.pins)
  ) {
    failPublication("integrity_failure");
  }
  const pins: Record<string, EmbeddingPin> = Object.create(null);
  for (const [profileId, pin] of Object.entries(document.pins as Record<string, unknown>)) {
    const { digest, pinned_at } = (pin ?? {}) as { digest?: unknown; pinned_at?: unknown };
    if (typeof digest !== "string" || !MODEL_DIGEST_PATTERN.test(digest) || typeof pinned_at !== "string") {
      failPublication("integrity_failure");
    }
    pins[profileId] = { digest, pinned_at };
  }
  return pins;
}
