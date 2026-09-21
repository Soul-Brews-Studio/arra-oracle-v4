import { closeSync } from "node:fs";

/**
 * Release the inherited writer descriptor.
 *
 * The flock is held by fd 42, not by the registry entry, so this is the step
 * that actually frees the dataset for another owner while this process keeps
 * running. Safe to call more than once.
 */
export function releaseInheritedGate(): void {
  const declared = process.env.ARRA_WRITER_FD;
  if (declared === undefined) return;
  const fd = Number(declared);
  if (!Number.isSafeInteger(fd) || fd < 0) return;
  try {
    closeSync(fd);
  } catch {
    // Already closed, or never ours. Either way there is nothing to release
    // and failing here would turn a clean shutdown into an error.
  }
}
