"""Preflight refusals and the source snapshot.

Everything here runs BEFORE any byte is written anywhere:

  - remote roots (``://``, e.g. ``s3://``) are refused -- the writer gate has
    no local inode to lock there, and R2 is out of scope tonight (R17);
  - the source must be an existing local directory holding all 15 legacy
    tables;
  - the candidate must be an EXISTING, EMPTY directory (no overwrite, no reset
    option: revision-publication-v1.md "No migration overwrite/reset option");
  - the work directory must be absent or empty, and none of the three may
    nest inside another.

The snapshot then hashes the ORIGINAL source tree (sha256 per file), copies it
into ``<work>/source-copy``, and proves the copy is byte-identical. The
migration reads only the copy; ``confirm_untouched`` re-hashes the original
afterwards and the report carries both digests.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path
from typing import Any

import lancedb

from ..models import TABLES as ACTIVE_TABLES


class CopyMigrationRefused(RuntimeError):
    """Refused before any write. ``code`` is a stable machine-readable reason."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def _local(path: str | os.PathLike[str], what: str) -> Path:
    text = os.fspath(path)
    if "://" in text:
        raise CopyMigrationRefused("remote_root", f"{what} must be a local directory, not {text!r}")
    if not text.strip():
        raise CopyMigrationRefused("invalid_path", f"{what} must be a non-empty path")
    return Path(text).resolve(strict=False)


def _nested(a: Path, b: Path) -> bool:
    return a == b or a in b.parents or b in a.parents


def preflight(source: Any, candidate: Any, work: Any) -> tuple[Path, Path, Path]:
    """Validate the three roots. Raises ``CopyMigrationRefused``; writes nothing."""

    src = _local(source, "source")
    cand = _local(candidate, "candidate")
    wrk = _local(work, "work")
    if not src.is_dir():
        raise CopyMigrationRefused("source_missing", f"source {src} is not a directory")
    if not cand.is_dir():
        raise CopyMigrationRefused("candidate_missing", f"candidate {cand} must be an existing empty directory")
    if any(cand.iterdir()):
        raise CopyMigrationRefused("candidate_not_empty", f"candidate {cand} is not empty; refusing to overwrite")
    if wrk.exists() and (not wrk.is_dir() or any(wrk.iterdir())):
        raise CopyMigrationRefused("work_not_empty", f"work directory {wrk} must be absent or empty")
    for a, b, names in ((src, cand, "source/candidate"), (src, wrk, "source/work"), (cand, wrk, "candidate/work")):
        if _nested(a, b):
            raise CopyMigrationRefused("nested_roots", f"{names} must be disjoint directories")
    present = set(lancedb.connect(str(src)).table_names(limit=1000))
    missing = sorted(set(ACTIVE_TABLES) - present)
    if missing:
        raise CopyMigrationRefused("source_not_legacy", f"source lacks legacy tables {missing}")
    return src, cand, wrk


def hash_tree(root: Path) -> tuple[dict[str, str], str]:
    """(relative path -> sha256, one digest over the whole sorted listing)."""

    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            files[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    overall = hashlib.sha256("".join(f"{k}\0{v}\n" for k, v in files.items()).encode("utf-8")).hexdigest()
    return files, overall


def snapshot_source(source: Path, work: Path) -> dict[str, Any]:
    """Hash the original, copy it into the work dir, prove the copy faithful."""

    files_before, digest_before = hash_tree(source)
    copy_root = work / "source-copy"
    shutil.copytree(source, copy_root, symlinks=True)
    _, digest_copy = hash_tree(copy_root)
    if digest_copy != digest_before:
        raise CopyMigrationRefused("snapshot_mismatch", "the source changed while it was being copied")
    db = lancedb.connect(str(copy_root))
    tables = {}
    for name in ACTIVE_TABLES:
        handle = db.open_table(name)
        tables[name] = {"rows": handle.count_rows(), "version": handle.version}
    return {
        "root": str(source),
        "copy_root": str(copy_root),
        "files": len(files_before),
        "tree_sha256_before": digest_before,
        "tables": tables,
    }


def confirm_untouched(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Re-hash the ORIGINAL source and record whether it is byte-identical."""

    _, digest_after = hash_tree(Path(snapshot["root"]))
    return {
        **snapshot,
        "tree_sha256_after": digest_after,
        "untouched": digest_after == snapshot["tree_sha256_before"],
    }
