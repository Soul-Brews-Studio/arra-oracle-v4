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

# R33 S4(a) (Nat 2026-09-28, docs/overnight/DECISIONS.md): the sibling root
# the ops tables (`mcp_calls`, `connections`, `instance_audit`) move to.
# Unset -> falls back to DATA_DIR, matching the TS side's `storage.opsStorageOptions.ts`
# exactly (unset changes nothing).
OPS_DIR = os.environ.get("ARRA_OPS_DIR", DATA_DIR)
OPS_DIR_IS_SEPARATE = "ARRA_OPS_DIR" in os.environ


def storage_options_for_root(root: str) -> Optional[dict]:
    """None for a local path, so `connect()` takes the same call either way."""
    if not root.startswith("s3://"):
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
            f"{root} needs {', '.join(missing)} — see ~/.config/arra-oracle-v4/r2.env"
        )

    return {
        "endpoint": endpoint,
        "region": os.environ.get("S3_REGION", "auto"),  # R2 ignores it; the client demands one
        "access_key_id": key,
        "secret_access_key": secret,
        # Only for a local http S3 (moto, MinIO). R2 is https and must stay so.
        "allow_http": str(endpoint.startswith("http://")).lower(),
    }


def storage_options() -> Optional[dict]:
    return storage_options_for_root(DATA_DIR)


def ops_storage_options() -> Optional[dict]:
    return storage_options_for_root(OPS_DIR)


def describe() -> str:
    return f"{DATA_DIR} ({'s3' if IS_REMOTE else 'local'})"


def describe_ops() -> str:
    return f"{OPS_DIR} ({'s3' if OPS_DIR.startswith('s3://') else 'local'})"
