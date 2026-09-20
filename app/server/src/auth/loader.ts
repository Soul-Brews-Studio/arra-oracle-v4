/**
 * Same-descriptor policy file I/O (`authorization-integration-v1.md` §2).
 *
 * The whole point is that exactly one descriptor is validated and read. We open
 * with O_NOFOLLOW, fstat THAT descriptor, bound the read from THAT descriptor,
 * and close it. Validating a pathname and then reopening it would be a
 * time-of-check/time-of-use gap, which is the failure this design exists to
 * avoid.
 *
 * There is no cache and no last-good fallback: a policy that cannot be read or
 * parsed denies the request, because a stale snapshot would silently outlive a
 * revocation. The snapshot linearizes at successful open, so an open before an
 * atomic rename may legitimately see the old inode and an open after it sees
 * the replacement.
 *
 * Parent-directory trust is an operator prerequisite; nothing here defends
 * against a malicious trusted operator or direct filesystem access.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { parsePolicy, type Policy } from "./policy";

/** One byte above the 256 KiB application cap, so the cap+1 byte is observable. */
export const MAX_POLICY_BYTES = 256 * 1024;
const READ_CEILING = MAX_POLICY_BYTES + 1;

export type LoaderFailure = "policy_unavailable";

export class PolicyUnavailableError extends Error {
  readonly code!: LoaderFailure;

  constructor() {
    super("policy unavailable");
    this.name = "PolicyUnavailableError";
    Object.defineProperty(this, "code", {
      value: "policy_unavailable",
      writable: false,
      enumerable: true,
      configurable: false,
    });
  }
}

function unavailable(): never {
  throw new PolicyUnavailableError();
}

/**
 * Read and validate the policy at `absolutePath`, returning a fresh snapshot.
 *
 * Every failure collapses to `policy_unavailable`: the caller must not be able
 * to distinguish "missing file" from "bad permissions" from "malformed JSON",
 * since that difference is useful to an attacker and useless to a legitimate
 * client.
 */
export function loadPolicy(absolutePath: string): Policy {
  if (typeof absolutePath !== "string" || !absolutePath.startsWith("/")) unavailable();

  let fd: number | undefined;
  try {
    // O_NOFOLLOW: a symlink at the final component fails with ELOOP rather than
    // silently redirecting us to a file the operator did not authorise.
    //
    // O_NONBLOCK: opening a FIFO read-only BLOCKS until a writer appears, which
    // would hang the event loop before fstat could reject the non-regular file.
    // With O_NONBLOCK the open returns immediately and the isFile() check below
    // does the rejecting. Harmless on a regular file, which is the only kind we
    // ultimately accept.
    fd = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);

    // fstat on the SAME descriptor -- not statSync(path), which could describe
    // a different inode than the one we are about to read.
    const stat = fstatSync(fd);
    if (!stat.isFile()) unavailable();
    if (stat.uid !== process.getuid?.()) unavailable();
    // No group or other bits at all: 0o077 must be clear.
    if ((stat.mode & 0o077) !== 0) unavailable();

    // Read one byte past the cap so that "exactly at the cap" and "over the
    // cap" are distinguishable rather than both looking like a full buffer.
    const buffer = Buffer.allocUnsafe(READ_CEILING);
    let filled = 0;
    for (;;) {
      const read = readSync(fd, buffer, filled, READ_CEILING - filled, null);
      if (read === 0) break;
      filled += read;
      if (filled >= READ_CEILING) break;
    }
    if (filled > MAX_POLICY_BYTES) unavailable();

    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, filled);
    // Copy out of the reusable buffer before it leaves this frame.
    return parsePolicy(Uint8Array.from(bytes));
  } catch (error) {
    if (error instanceof PolicyUnavailableError) throw error;
    // parsePolicy's own codes are deliberately collapsed too: a caller learning
    // "your policy file is malformed" learns about server state they cannot see.
    return unavailable();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close must not turn a good read into a denial, nor mask one.
      }
    }
  }
}
