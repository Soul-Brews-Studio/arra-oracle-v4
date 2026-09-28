import { statSync } from "node:fs";
import { failPublication } from "./errors";
import { realpathOrFail } from "./storage.realpathOrFail";

/**
 * A dataset root must be a local directory, resolved through REALPATH.
 *
 * Python's gate uses `Path.resolve()`, which follows symlinks. A lexical
 * resolve here would make the two languages disagree about which dataset an
 * alias names, and the shared lock would stop being shared.
 */
export function assertLocalDatasetRoot(datasetRoot: unknown): string {
  if (typeof datasetRoot !== "string" || !datasetRoot.trim()) failPublication("unsupported_dataset");
  if (datasetRoot.includes("://")) failPublication("unsupported_dataset");
  const canonical = realpathOrFail(datasetRoot);
  try {
    if (!statSync(canonical).isDirectory()) failPublication("unsupported_dataset");
  } catch {
    return failPublication("unsupported_dataset");
  }
  return canonical;
}
