"""Scratch-only Python -> Arrow -> TS fixture. Never imported by the migrator."""

import json
import sys
from datetime import datetime
from pathlib import Path

import lancedb
from arra_migrate.contract_v1 import (
    canonical_message,
    message_digest,
    parse_timestamp,
    validate_id,
)
from lancedb.pydantic import LanceModel, Vector


class CodecFixture(LanceModel):
    id: str
    seq: int
    created_at: datetime
    source_created_at: datetime | None = None
    canonical_json: str
    digest: str
    embedding: Vector(384) | None = None


def main():
    root = Path(sys.argv[1]).resolve()
    target = root / "codec-lancedb"
    # Refuse an existing child path: no overwrite/reset mode, including on retry.
    target.mkdir(exist_ok=False)
    payload = json.load(sys.stdin)
    canonical = canonical_message(payload)
    digest = message_digest(payload)
    db = lancedb.connect(str(target))
    table = db.create_table("codec_fixture", schema=CodecFixture)
    utc_naive = parse_timestamp(payload["source_created_at"]).replace(tzinfo=None)
    table.add([
        CodecFixture(
            id=validate_id(identifier),
            seq=9223372036854775807,
            created_at=utc_naive,
            source_created_at=source_time,
            canonical_json=canonical.decode("utf-8"),
            digest=digest,
        )
        for identifier, source_time in [
            ("Abcdefghijklmnopq_012", None),
            ("Abcdefghijklmnopq_013", utc_naive),
        ]
    ])
    print(json.dumps({"canonical_hex": canonical.hex(), "digest": digest, "rows": table.count_rows()}))


if __name__ == "__main__":
    main()
