import { fstatSync, lstatSync } from "node:fs";
import { failPublication } from "./errors";
import { realpathOrFail } from "./storage.realpathOrFail";

/** Must match `writer_gate.LOCK_FILENAME`. */
export const LOCK_FILENAME = ".arra-writer.lock";
/** Must match `writer_gate.INHERITED_FD`; the descriptor number is fixed. */
export const INHERITED_FD = 42;
const ENV_FD = "ARRA_WRITER_FD";
const ENV_ROOT = "ARRA_WRITER_ROOT";

/**
 * Verify the inherited descriptor IS this dataset's gate.
 *
 * Every check runs on the DESCRIPTOR, not on a path that could have changed
 * identity since it was named. An ordinary unwrapped launch has no such
 * descriptor and is refused before any connection is opened.
 */
export function assertInheritedGate(canonicalRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  const declaredFd = env[ENV_FD];
  const declaredRoot = env[ENV_ROOT];
  if (typeof declaredFd !== "string" || typeof declaredRoot !== "string") {
    failPublication("writer_unavailable");
  }
  // The descriptor number is FIXED by the gate protocol; accepting an
  // arbitrary number would let any open file masquerade as the lock.
  if (declaredFd !== String(INHERITED_FD)) failPublication("writer_unavailable");
  if (realpathOrFail(declaredRoot) !== canonicalRoot) failPublication("writer_unavailable");

  let held: ReturnType<typeof fstatSync>;
  try {
    held = fstatSync(INHERITED_FD);
  } catch {
    return failPublication("writer_unavailable");
  }
  if (!held.isFile()) failPublication("writer_unavailable");
  if (held.uid !== process.getuid?.()) failPublication("writer_unavailable");
  // EXACTLY 0600. Checking only the group/other bits would accept 0400 or
  // 0700, neither of which is the mode the gate creates.
  if ((held.mode & 0o777) !== 0o600) failPublication("writer_unavailable");
  if (held.nlink !== 1) failPublication("writer_unavailable");

  // lstatSync, genuinely: statSync FOLLOWS a symlink, so a link planted at
  // the lock path could resolve to an inode that happens to match the held
  // descriptor. The comment previously said lstat while the code did not.
  let onDisk: ReturnType<typeof lstatSync>;
  try {
    onDisk = lstatSync(`${canonicalRoot}/${LOCK_FILENAME}`, { throwIfNoEntry: true });
  } catch {
    return failPublication("writer_unavailable");
  }
  if (!onDisk.isFile()) failPublication("writer_unavailable");
  if (held.ino !== onDisk.ino || held.dev !== onDisk.dev) failPublication("writer_unavailable");
}
