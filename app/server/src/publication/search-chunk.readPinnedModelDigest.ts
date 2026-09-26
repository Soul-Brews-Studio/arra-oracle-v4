import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fixed sidecar filename, one JSON object, living directly under the
 * knowledge dataset root -- not a LanceDB table (Python/`app/migrate-py`
 * owns that schema, per this repo's split), just a small operational cache
 * file next to it, the same relationship `ARRA_DATA_DIR`'s legacy tables
 * have to the process that writes them. `search-chunk.writePinnedModelDigest.ts`
 * is this file's only writer.
 */
export const PINNED_DIGEST_FILE_NAME = ".embedding-model-digest.json";

/**
 * Read a previously-pinned embedding-model digest for `model`, if this
 * dataset root has one.
 *
 * #30 R7 TODO 4 ("pin model identity/version"), fix-round finding 4: a live
 * `/api/tags` probe at every boot makes the active `profile_id` depend on
 * whether Ollama happened to answer THAT boot -- measured, two boots of the
 * identical installed model produced two different ids (`unmeasured` vs the
 * real digest), and every vector embedded under the first id was orphaned
 * the moment the second boot changed the answer. Once a real digest has
 * ever been measured for a given model, `search-chunk.pinActiveEmbeddingModelDigest.ts`
 * persists it here so every LATER boot reuses the SAME identity regardless
 * of Ollama's reachability that particular time, until the operator changes
 * `EMBEDDING_MODEL`.
 *
 * The `model` the pin was recorded under is checked, not just its digest --
 * a stale pin from a since-changed `EMBEDDING_MODEL` must never be silently
 * reattached to a different model's identity.
 *
 * Never throws: a missing file, an unreadable directory, malformed JSON or a
 * model mismatch all read as "not yet pinned" (`null`) -- the same "never a
 * crash" contract `fetchOllamaModelDigest` itself keeps.
 */
export function readPinnedModelDigest(datasetRoot: string, model: string): string | null {
  try {
    const path = join(datasetRoot, PINNED_DIGEST_FILE_NAME);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown; digest?: unknown };
    if (parsed.model !== model) return null;
    return typeof parsed.digest === "string" && parsed.digest.length > 0 ? parsed.digest : null;
  } catch {
    return null;
  }
}
