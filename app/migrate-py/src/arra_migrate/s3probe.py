"""Does LanceDB actually commit to an S3-compatible object store?

    uv run arra-s3probe                      # local moto, no credentials
    S3_TARGET=r2 uv run arra-s3probe         # Cloudflare R2

The SAME `connect()` call in both cases -- only `endpoint`, the keys and
`allow_http` differ. That is the whole point: if this passes locally and
fails on R2, the difference is Cloudflare's S3 surface, not our code.

R2 needs an S3 access key, which `wrangler` cannot mint (there is no
`r2 token` subcommand). Dashboard: R2 > API > Manage API tokens >
Create token > Object Read & Write, scoped to one bucket. Then:

    export R2_ACCOUNT_ID=...
    export AWS_ACCESS_KEY_ID=...
    export AWS_SECRET_ACCESS_KEY=...
    S3_TARGET=r2 uv run arra-s3probe

Step 5 is the load-bearing one. A SECOND write means the manifest commit
succeeded -- the operation that needed DynamoDB until lance-format#2793
made conditional put the default. R2 supports If-Match/If-None-Match on
PutObject, so it should hold; this is how we find out rather than assume.
"""

import os
import sys
import time

import boto3
import lancedb
import pyarrow as pa

from .embeddings import EMBEDDING_DIM

TARGET = os.environ.get("S3_TARGET", "local")
BUCKET = os.environ.get("S3_BUCKET", "arra-oracle-v4-poc")

if TARGET == "r2":
    ACCOUNT = os.environ.get("R2_ACCOUNT_ID") or sys.exit("set R2_ACCOUNT_ID")
    ENDPOINT = f"https://{ACCOUNT}.r2.cloudflarestorage.com"
    ALLOW_HTTP = "false"
else:
    ENDPOINT = os.environ.get("S3_ENDPOINT", "http://127.0.0.1:5555")
    ALLOW_HTTP = "true"

KEY = os.environ.get("AWS_ACCESS_KEY_ID", "test")
SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "test")

# R2 ignores region but the S3 client insists on one. `auto` is what
# Cloudflare's own docs use.
REGION = os.environ.get("S3_REGION", "auto")

STORAGE_OPTIONS = {
    "endpoint": ENDPOINT,
    "region": REGION,
    "access_key_id": KEY,
    "secret_access_key": SECRET,
    "allow_http": ALLOW_HTTP,
}

ROWS = [
    {"id": "m1", "content": "ความทรงจำ คือ สิ่งที่เราเลือกจะไม่ลืม"},
    {"id": "m2", "content": "supersede, never delete"},
]


def step(n, q):
    print(f"\n# Step {n} — {q}", flush=True)


def note(m):
    print(f"- {m}", flush=True)


def main() -> int:
    note(f"target={TARGET} · endpoint={ENDPOINT} · bucket={BUCKET}")
    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=KEY,
        aws_secret_access_key=SECRET,
        region_name="us-east-1",  # signing region; R2 accepts any
    )

    step(1, "bucket reachable")
    try:
        s3.head_bucket(Bucket=BUCKET)
        note(f"`{BUCKET}` exists")
    except Exception:
        s3.create_bucket(Bucket=BUCKET)
        note(f"created `{BUCKET}`")

    step(2, "connect")
    uri = f"s3://{BUCKET}/data"
    db = lancedb.connect(uri, storage_options=STORAGE_OPTIONS)
    note(f"`{uri}` · existing tables: {db.table_names()}")

    step(3, "create table and write")
    schema = pa.schema([
        pa.field("id", pa.string()),
        pa.field("content", pa.string()),
        pa.field("embedding", pa.list_(pa.float32(), EMBEDDING_DIM), nullable=True),
    ])
    t = time.perf_counter()
    tb = db.create_table("memories", schema=schema, mode="overwrite")
    tb.add([{**r, "embedding": None} for r in ROWS])
    note(f"{tb.count_rows()} rows in {(time.perf_counter() - t) * 1000:.0f} ms · version={tb.version}")

    step(4, "read back through a fresh connection")
    tb2 = lancedb.connect(uri, storage_options=STORAGE_OPTIONS).open_table("memories")
    note(f"rows={tb2.count_rows()} · fields={[f.name for f in tb2.schema]}")
    for r in tb2.to_arrow().to_pylist():
        note(f"  {r['id']}: {r['content']}")

    step(5, "SECOND write — the manifest commit (conditional put)")
    t = time.perf_counter()
    tb2.add([{"id": "m3", "content": "แทนที่ ไม่ลบ", "embedding": None}])
    note(f"appended in {(time.perf_counter() - t) * 1000:.0f} ms · rows={tb2.count_rows()} · version={tb2.version}")
    note("=> commit succeeded. No DynamoDB, no external lock.")

    step(6, "what landed in the bucket")
    objs = s3.list_objects_v2(Bucket=BUCKET).get("Contents", [])
    note(f"{len(objs)} objects · {sum(o['Size'] for o in objs)} bytes")
    for o in sorted(objs, key=lambda x: x["Key"])[:12]:
        note(f"  {o['Size']:>8} B  {o['Key']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
