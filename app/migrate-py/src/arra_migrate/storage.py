"""Where the dataset lives. ONE env var decides.

    ARRA_DATA_DIR=../data                        local (default)
    ARRA_DATA_DIR=s3://arra-oracle-v4-poc/data   R2

Mirrors server/src/storage.ts. Change both or neither.

Measured against real R2 2026-09-18: create+write 2310 ms, second write (the
manifest commit) 1155 ms, versus 11 ms / 5 ms on a local S3. Lance needs no
DynamoDB for that commit -- conditional put has been the default since
lance-format#2793, and R2 honours If-Match/If-None-Match.
"""

import os
from typing import Optional

DATA_DIR = os.environ.get("ARRA_DATA_DIR", "../data")
IS_REMOTE = DATA_DIR.startswith("s3://")


def storage_options() -> Optional[dict]:
    """None for a local path, so `connect()` takes the same call either way."""
    if not IS_REMOTE:
        return None

    account = os.environ.get("R2_ACCOUNT_ID")
    endpoint = os.environ.get("S3_ENDPOINT") or (
        f"https://{account}.r2.cloudflarestorage.com" if account else None
    )
    key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret = os.environ.get("AWS_SECRET_ACCESS_KEY")

    # Fail here rather than let LanceDB retry an unauthenticated request and
    # surface it later as a confusing 400 from the object store.
    missing = [
        n for n, v in (
            ("S3_ENDPOINT or R2_ACCOUNT_ID", endpoint),
            ("AWS_ACCESS_KEY_ID", key),
            ("AWS_SECRET_ACCESS_KEY", secret),
        ) if not v
    ]
    if missing:
        raise SystemExit(
            f"{DATA_DIR} needs {', '.join(missing)} — see ~/.config/arra-oracle-v4/r2.env"
        )

    return {
        "endpoint": endpoint,
        "region": os.environ.get("S3_REGION", "auto"),  # R2 ignores it; the client demands one
        "access_key_id": key,
        "secret_access_key": secret,
        # Only for a local http S3 (moto, MinIO). R2 is https and must stay so.
        "allow_http": str(endpoint.startswith("http://")).lower(),
    }


def describe() -> str:
    return f"{DATA_DIR} ({'s3' if IS_REMOTE else 'local'})"
