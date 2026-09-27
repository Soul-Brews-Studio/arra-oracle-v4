# /// script
# requires-python = ">=3.10"
# dependencies = ["pylance", "pandas"]
# ///
"""Read a Lance dataset straight off disk. No lancedb, no server, no Docker.

`lance.dataset()` opens the directory itself, so this works whether or not the
app is running -- and it reads the version the directory is at right now, which
a long-lived cached handle would not.
"""
import sys

import lance

path, cmd = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "schema")
ds = lance.dataset(path)

if cmd == "schema":
    print(f"{path}\nversion={ds.version} rows={ds.count_rows()}\n")
    print(ds.schema)
elif cmd == "versions":
    for v in ds.versions():
        print(f"v{v['version']:<4} {v['timestamp']}")
elif cmd == "rows":
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 20
    df = ds.to_table().to_pandas()
    if df.empty:
        print("(no rows)")
    else:
        df["embedded"] = df["embedding"].notna()
        cols = [c for c in ["id", "name", "workspace_name", "type", "sync_state", "embedded"] if c in df]
        print(df[cols].head(limit).to_string(index=False))
else:
    sys.exit(f"unknown command: {cmd}")
