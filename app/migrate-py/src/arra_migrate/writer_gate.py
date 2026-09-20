"""Cooperative local writer exclusion for target dataset mutation.

Every writer of a target dataset -- Python fixture creation and the TypeScript
publication kernel alike -- takes THIS gate before opening a writable
connection. That is the whole protocol: a lock nobody is obliged to take
protects nothing, so the rule is "acquire before connect", without exception.

Scope, stated plainly and deliberately narrow:

* This is a COOPERATIVE exclusion protocol inside a trusted local operator
  boundary. It is not a multiwriter CAS, not a distributed lease, and not
  protection against arbitrary same-UID code that simply declines to ask.
* Measured on Darwin/POSIX with Python 3.12.13 and Bun 1.3.14. `flock`
  inheritance through `exec` and kernel release on owned-process death were
  demonstrated there. Nothing here establishes Linux, NFS, R2, or any other
  runtime.
* There is no timeout lease and no stale-lock deletion. A lock held by a live
  process is honoured; a lock held by a dead one is released by the kernel.
  Deleting someone else's lock file to make progress would defeat the point.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import stat
from collections.abc import Iterator
from pathlib import Path

__all__ = [
    "INHERITED_FD",
    "LOCK_FILENAME",
    "UnsupportedDatasetError",
    "WriterUnavailableError",
    "canonical_dataset_root",
    "exec_with_gate",
    "writer_gate",
]

#: Lives inside the dataset directory so the lock travels with the data.
LOCK_FILENAME = ".arra-writer.lock"

#: The descriptor number the gate dups onto before exec, for the child to adopt.
INHERITED_FD = 42

#: Environment fields that LOCATE the inherited descriptor. They are not proof
#: of ownership -- a child must still verify the descriptor it was handed.
ENV_FD = "ARRA_WRITER_FD"
ENV_ROOT = "ARRA_WRITER_ROOT"


class WriterUnavailableError(RuntimeError):
    """Another live owner holds the gate. Raised BEFORE any dataset connect."""

    code = "writer_unavailable"


class UnsupportedDatasetError(RuntimeError):
    """The dataset root or lock file is not a shape this gate will accept."""

    code = "unsupported_dataset"


def canonical_dataset_root(dataset_root: str | os.PathLike[str]) -> Path:
    """Resolve to a real local directory path.

    Aliases (symlinks, `..` segments, differing spellings) must resolve to the
    SAME path so two spellings of one dataset contend for one lock rather than
    quietly taking two different ones.
    """
    if not isinstance(dataset_root, (str, os.PathLike)):
        raise UnsupportedDatasetError("dataset root must be a local path")
    text = os.fspath(dataset_root)
    # Remote/object storage has no local inode to lock; refuse rather than
    # pretend the gate means anything there.
    if "://" in text:
        raise UnsupportedDatasetError("remote dataset storage is not supported")
    if not text.strip():
        raise UnsupportedDatasetError("dataset root must be a non-empty path")
    resolved = Path(text).resolve(strict=False)
    if not resolved.is_dir():
        raise UnsupportedDatasetError("dataset root must be an existing directory")
    return resolved


def _open_lock_descriptor(root: Path) -> int:
    """Open (or create) the lock file and validate it on that SAME descriptor.

    Validating a pathname and then opening it again would leave a window for
    the file to change identity in between, so every check below is an fstat on
    the descriptor actually held.
    """
    path = root / LOCK_FILENAME
    # O_NOFOLLOW: a symlink here would redirect the lock somewhere unintended.
    flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
    try:
        fd = os.open(path, flags, 0o600)
    except OSError as error:
        # ELOOP is exactly the symlink refusal above doing its job. Surface it
        # in this gate's own vocabulary rather than leaking a raw errno, so a
        # caller distinguishes "unsupported dataset" from "busy writer".
        raise UnsupportedDatasetError("writer lock path is not a usable regular file") from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise UnsupportedDatasetError("writer lock must be a regular file")
        if info.st_uid != os.getuid():
            raise UnsupportedDatasetError("writer lock must be owned by the current user")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise UnsupportedDatasetError("writer lock must have mode 0600")
        if info.st_nlink != 1:
            raise UnsupportedDatasetError("writer lock must have exactly one link")
    except BaseException:
        os.close(fd)
        raise
    return fd


@contextlib.contextmanager
def writer_gate(dataset_root: str | os.PathLike[str]) -> Iterator[int]:
    """Hold exclusive cooperative write access for `dataset_root`.

    Yields the held descriptor. The lock is NON-BLOCKING: a contender fails
    immediately with `writer_unavailable` rather than queueing, because a
    caller that waited would have no way to know whether it was about to wait
    for a millisecond or forever.

    The file is never unlinked, stolen or replaced. Release is by closing the
    descriptor, which is also what the kernel does when the owner dies.
    """
    root = canonical_dataset_root(dataset_root)
    fd = _open_lock_descriptor(root)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise WriterUnavailableError("dataset writer unavailable") from error
        yield fd
    finally:
        # Closing releases the flock. Deliberately no unlink: the file's
        # existence is not ownership, and removing it would strand a contender.
        os.close(fd)


def exec_with_gate(
    dataset_root: str | os.PathLike[str],
    argv: list[str],
    *,
    env: dict[str, str] | None = None,
) -> None:
    """Acquire the gate, then REPLACE this process with `argv`.

    On success this never returns: `execvpe` overwrites the process image, so
    the program that runs afterwards is the sole owner of the lock.

    That is the whole point, and it is why this is an exec rather than a fork.
    A fork would leave the Python parent alive and still holding the same lock,
    which would make any "the child inherited it" test pass even if the child
    had lost the descriptor entirely -- the contender would be blocked by the
    surviving parent, not by the child. One owner, one process.

    A caller must therefore be a process it is willing to lose. Harnesses
    launch this as their own subprocess and kill/reap that PID.
    """
    root = canonical_dataset_root(dataset_root)
    if not argv:
        raise UnsupportedDatasetError("a program argv is required")

    fd = _open_lock_descriptor(root)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        os.close(fd)
        raise WriterUnavailableError("dataset writer unavailable") from error

    child_env = dict(os.environ if env is None else env)
    child_env[ENV_FD] = str(INHERITED_FD)
    child_env[ENV_ROOT] = str(root)

    try:
        # dup2 clears CLOEXEC on the destination, so fd 42 survives exec. Both
        # descriptors share ONE open file description, which is what carries
        # the flock -- so closing the original below does not release it.
        os.dup2(fd, INHERITED_FD, inheritable=True)
        if fd != INHERITED_FD:
            os.close(fd)
        os.execvpe(argv[0], argv, child_env)
    except BaseException:
        # Reached only if exec FAILED; on success there is no "after" here.
        with contextlib.suppress(OSError):
            os.close(INHERITED_FD)
        raise
