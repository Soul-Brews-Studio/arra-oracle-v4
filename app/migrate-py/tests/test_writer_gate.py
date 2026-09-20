"""Writer-gate evidence: real contention, real child processes, real kills.

Every process here is one this test owns and reaps, with a parent-enforced
deadline. Nothing kills by pattern, nothing touches a live dataset, and no
assertion depends on a sleep being "long enough" -- contention is observed
through the gate's own non-blocking failure, not through timing.

What these tests do NOT establish, stated up front: this is a cooperative
protocol. Code that declines to take the gate is not stopped by it, and no
claim about Linux, NFS, R2 or malicious same-UID processes follows.
"""

from __future__ import annotations

import contextlib
import os
import selectors
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

from arra_migrate.writer_gate import (
    INHERITED_FD,
    LOCK_FILENAME,
    UnsupportedDatasetError,
    canonical_dataset_root,
    writer_gate,
)

CHILD_DEADLINE_SECONDS = 20


def shutdown_child(child: subprocess.Popen) -> None:
    """Kill, reap and CLOSE. Leaving pipes open raises ResourceWarning, which
    the contract's Python discovery treats as an error."""
    try:
        child.kill()
        child.wait(timeout=CHILD_DEADLINE_SECONDS)
    finally:
        for stream in (child.stdout, child.stderr, child.stdin):
            if stream is not None:
                with contextlib.suppress(Exception):
                    stream.close()


def read_line_by_deadline(stream, deadline_seconds: float = CHILD_DEADLINE_SECONDS) -> str:
    """Read one line, bounded by a real deadline.

    A plain `stream.readline()` blocks forever if the child never writes, which
    would hang the suite instead of failing it -- and would make any claim that
    every child is parent-bounded false.
    """
    selector = selectors.DefaultSelector()
    selector.register(stream, selectors.EVENT_READ)
    buffer = b""
    end = time.monotonic() + deadline_seconds
    try:
        while time.monotonic() < end:
            if not selector.select(timeout=max(0.0, end - time.monotonic())):
                break
            chunk = os.read(stream.fileno(), 1)
            if not chunk:
                break
            buffer += chunk
            if chunk == b"\n":
                return buffer.decode("utf-8", "replace")
    finally:
        selector.unregister(stream)
        selector.close()
    return buffer.decode("utf-8", "replace")


def run_child(source: str, *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    """Run an owned Python child with a parent-enforced deadline and reap it."""
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "child.py"
        script.write_text(textwrap.dedent(source), encoding="utf-8")
        child = subprocess.Popen(  # fixed argv, owned script
            [sys.executable, str(script)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, **(env or {})},
        )
        try:
            out, err = child.communicate(timeout=CHILD_DEADLINE_SECONDS)
        except subprocess.TimeoutExpired:
            child.kill()
            out, err = child.communicate()
            raise AssertionError("child exceeded its deadline; the gate may be blocking")
        return subprocess.CompletedProcess(child.args, child.returncode, out, err)


class CanonicalRootTests(unittest.TestCase):
    def test_aliases_of_one_directory_resolve_to_one_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "data"
            root.mkdir()
            link = Path(tmp) / "alias"
            link.symlink_to(root)
            # Symlink, dotted path and plain spelling must all agree, or two
            # spellings of one dataset would take two different locks.
            self.assertEqual(canonical_dataset_root(root), canonical_dataset_root(link))
            self.assertEqual(
                canonical_dataset_root(root),
                canonical_dataset_root(str(root) + "/./"),
            )
            self.assertEqual(canonical_dataset_root(root), canonical_dataset_root(Path(tmp) / "data" / ".." / "data"))

    def test_remote_and_missing_roots_are_refused(self):
        for bad in ["s3://bucket/data", "https://example.invalid/data", "", "   "]:
            with self.subTest(root=bad), self.assertRaises(UnsupportedDatasetError):
                canonical_dataset_root(bad)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(UnsupportedDatasetError):
                canonical_dataset_root(Path(tmp) / "absent")
            regular = Path(tmp) / "afile"
            regular.write_text("x", encoding="utf-8")
            with self.assertRaises(UnsupportedDatasetError):
                canonical_dataset_root(regular)


class LockFileShapeTests(unittest.TestCase):
    def test_the_lock_is_created_0600_regular_and_single_linked(self):
        with tempfile.TemporaryDirectory() as tmp, writer_gate(tmp):
            info = (Path(tmp) / LOCK_FILENAME).stat()
            self.assertTrue(stat.S_ISREG(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            self.assertEqual(info.st_nlink, 1)
            self.assertEqual(info.st_uid, os.getuid())

    def test_a_symlinked_lock_path_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "elsewhere"
            target.write_text("", encoding="utf-8")
            (Path(tmp) / LOCK_FILENAME).symlink_to(target)
            with self.assertRaises(UnsupportedDatasetError), writer_gate(tmp):
                pass

    def test_a_group_readable_lock_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            lock = Path(tmp) / LOCK_FILENAME
            lock.touch(mode=0o644)
            os.chmod(lock, 0o644)
            with self.assertRaises(UnsupportedDatasetError), writer_gate(tmp):
                pass

    def test_release_never_unlinks_the_lock_file(self):
        # Existence is not ownership; deleting it would strand a contender.
        with tempfile.TemporaryDirectory() as tmp:
            with writer_gate(tmp):
                pass
            self.assertTrue((Path(tmp) / LOCK_FILENAME).exists())


class ContentionTests(unittest.TestCase):
    CONTENDER = """
        import sys
        from arra_migrate.writer_gate import writer_gate, WriterUnavailableError
        try:
            with writer_gate(sys.argv[0] and {root!r}):
                print("ACQUIRED")
        except WriterUnavailableError as error:
            print("UNAVAILABLE:" + error.code)
    """

    def test_a_second_process_is_refused_while_the_first_holds_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            with writer_gate(tmp):
                result = run_child(self.CONTENDER.format(root=str(tmp)))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("UNAVAILABLE:writer_unavailable", result.stdout)

    def test_an_ALIAS_path_contends_for_the_same_lock(self):
        # The contention that matters: two spellings, one dataset, one lock.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "data"
            root.mkdir()
            alias = Path(tmp) / "alias"
            alias.symlink_to(root)
            with writer_gate(root):
                result = run_child(self.CONTENDER.format(root=str(alias)))
            self.assertIn("UNAVAILABLE:writer_unavailable", result.stdout)

    def test_the_gate_is_free_again_after_the_holder_exits(self):
        with tempfile.TemporaryDirectory() as tmp:
            with writer_gate(tmp):
                pass
            result = run_child(self.CONTENDER.format(root=str(tmp)))
            self.assertIn("ACQUIRED", result.stdout)

    def test_the_kernel_releases_the_lock_when_an_owner_is_KILLED(self):
        # Not a graceful release: the owner is SIGKILLed mid-hold, so only the
        # kernel can free it. No stale-lock deletion is involved.
        with tempfile.TemporaryDirectory() as tmp:
            holder_source = textwrap.dedent(f"""
                import sys, time
                from arra_migrate.writer_gate import writer_gate
                with writer_gate({str(tmp)!r}):
                    print("HELD", flush=True)
                    time.sleep(60)
            """)
            script = Path(tmp) / "holder.py"
            script.write_text(holder_source, encoding="utf-8")
            holder = subprocess.Popen(  # fixed argv, owned script
                [sys.executable, str(script)], stdout=subprocess.PIPE, text=True, env=dict(os.environ)
            )
            try:
                # Bounded readiness: a blocking readline here would hang the
                # suite forever if the holder never printed.
                line = read_line_by_deadline(holder.stdout) if holder.stdout else ""
                self.assertIn("HELD", line, "holder never acquired the gate")
                blocked = run_child(self.CONTENDER.format(root=str(tmp)))
                self.assertIn("UNAVAILABLE", blocked.stdout)
            finally:
                # Exact owned PID, killed, reaped and its pipes closed --
                # never a pattern match.
                shutdown_child(holder)
            freed = run_child(self.CONTENDER.format(root=str(tmp)))
            self.assertIn("ACQUIRED", freed.stdout, "kernel did not release the lock on owner death")


class ExecInheritanceTests(unittest.TestCase):
    """The exec'd program is the SOLE owner; no Python parent survives holding it.

    Every test here launches `exec_with_gate` as an owned subprocess and then
    kills and reaps THAT SAME PID. Because the launcher execs in place, that
    PID *is* the lock owner -- there is no second waiting holder that could
    make a contender look blocked for the wrong reason.
    """

    LAUNCHER = """
        import sys
        from arra_migrate.writer_gate import exec_with_gate
        exec_with_gate({root!r}, [sys.executable, {probe!r}])
        print("EXEC_FAILED")   # unreachable on success
        sys.exit(9)
    """

    HOLDER_PROBE = """
        import os, sys, time
        fd = {fd}
        os.fstat(fd)                      # the descriptor really arrived
        sys.stdout.write("HOLDING\\n")
        sys.stdout.flush()
        time.sleep(120)
    """

    #: Deliberately DROPS the inherited lock, to prove the tests can see that.
    DROPPER_PROBE = """
        import fcntl, os, sys, time
        fd = {fd}
        fcntl.flock(fd, fcntl.LOCK_UN)    # give the gate up on purpose
        sys.stdout.write("HOLDING\\n")
        sys.stdout.flush()
        time.sleep(120)
    """

    CONTENDER = """
        from arra_migrate.writer_gate import writer_gate, WriterUnavailableError
        try:
            with writer_gate({root!r}):
                print("ACQUIRED")
        except WriterUnavailableError:
            print("UNAVAILABLE")
    """

    def _start_owner(self, root: Path, probe_source: str) -> subprocess.Popen[str]:
        probe = root / "probe.py"
        probe.write_text(textwrap.dedent(probe_source).format(fd=INHERITED_FD), encoding="utf-8")
        launcher = root / "launcher.py"
        launcher.write_text(
            textwrap.dedent(self.LAUNCHER).format(root=str(root), probe=str(probe)),
            encoding="utf-8",
        )
        owner = subprocess.Popen(  # fixed argv, owned script
            [sys.executable, str(launcher)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=dict(os.environ),
        )
        try:
            ready = read_line_by_deadline(owner.stdout) if owner.stdout else ""
        except BaseException:
            # A readiness failure must not leak a live lock holder: that would
            # poison every later test in this file with a phantom contender.
            shutdown_child(owner)
            raise
        if "HOLDING" not in ready:
            shutdown_child(owner)
            raise AssertionError("exec'd probe never reported readiness")
        return owner, ready

    def _contend(self, root: Path) -> str:
        return run_child(self.CONTENDER.format(root=str(root))).stdout.strip()

    def test_the_execd_program_holds_the_gate_and_blocks_a_contender(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            owner, ready = self._start_owner(root, self.HOLDER_PROBE)
            try:
                self.assertIn("HOLDING", ready, "exec'd probe never reported readiness")
                # The ACTUAL expected event, not merely a zero exit status.
                self.assertEqual(self._contend(root), "UNAVAILABLE")
            finally:
                shutdown_child(owner)  # exact owned PID -- which IS the owner

    def test_killing_that_exact_pid_frees_the_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            owner, ready = self._start_owner(root, self.HOLDER_PROBE)
            killed = False
            try:
                self.assertIn("HOLDING", ready)
                self.assertEqual(self._contend(root), "UNAVAILABLE")
                shutdown_child(owner)
                killed = True
                # Only the kernel released this; nothing unlinks the file.
                self.assertEqual(self._contend(root), "ACQUIRED")
            finally:
                # If an assertion above failed BEFORE the kill, the owner is
                # still alive and holding the gate.
                if not killed:
                    shutdown_child(owner)

    def test_SENSITIVITY_a_probe_that_drops_the_lock_is_detected(self):
        """If the exec'd program loses the gate, the contention test must notice.

        This is the check that would have caught the earlier fork-based
        launcher: with a surviving Python parent still holding the lock, a
        contender reported UNAVAILABLE even though the child had released it,
        so the inheritance evidence proved nothing.
        """
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            owner, ready = self._start_owner(root, self.DROPPER_PROBE)
            try:
                self.assertIn("HOLDING", ready)
                # The exec'd process is alive but has UNLOCKED, and because no
                # parent survives holding it, the gate is genuinely free.
                self.assertEqual(
                    self._contend(root),
                    "ACQUIRED",
                    "a dropped gate was still reported busy -- a surviving holder is masking it",
                )
            finally:
                shutdown_child(owner)

    def test_no_python_launcher_process_survives_the_exec(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            owner, ready = self._start_owner(root, self.HOLDER_PROBE)
            try:
                self.assertIn("HOLDING", ready)
                # The launcher PID is now the probe itself: exec replaced the
                # image in place rather than forking a second process.
                cmdline = subprocess.run(  # fixed argv
                    ["ps", "-o", "command=", "-p", str(owner.pid)],
                    capture_output=True, text=True, timeout=CHILD_DEADLINE_SECONDS,
                    check=False,
                ).stdout
                self.assertIn("probe.py", cmdline)
                self.assertNotIn("launcher.py", cmdline)
            finally:
                shutdown_child(owner)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
