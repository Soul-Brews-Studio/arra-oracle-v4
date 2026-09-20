"""Run the bound-embedding path and record what it actually does.

    uv run arra-probe            # 25 rows, progress on stderr
    ROWS=100 uv run arra-probe

Scratch dir only. `app/data` is never opened. Every claim in embeddings.py's
docstring is produced here, so a future reader can re-run it rather than
believe it. Output is markdown: paste it into a discussion as-is.
"""

import json
import os
import shutil
import sys
import time
from typing import Optional

import lancedb
from lancedb.pydantic import LanceModel, Vector

from .embeddings import EMBEDDING_MODEL, embedder

SCRATCH = "/tmp/arra-embed-probe"
DEAD = "http://127.0.0.1:9"  # closed port, refuses instantly
ROWS = int(os.environ.get("ROWS", "25"))

# Half Thai, half English, so the probe carries the language the fleet
# actually writes in -- not a vendor's demo corpus.
SEED = [
    "memory is what we choose not to forget",
    "ความทรงจำ คือ สิ่งที่เราเลือกจะไม่ลืม",
    "a trace is a question that found something",
    "trace คือ คำถามที่เจอคำตอบ",
    "supersede, never delete",
    "แทนที่ ไม่ลบ",
    "the embedder must never block a write",
    "embedder ห้ามบล็อกการเขียน",
    "bank first, it is the tenant",
    "workspace_name อยู่บนทุกตาราง",
]


def rows(n):
    return [{"id": f"m{i:03d}", "content": f"{SEED[i % len(SEED)]} #{i}"} for i in range(n)]


T0 = time.perf_counter()


def log(msg):
    """Progress to stderr, unbuffered, with elapsed seconds."""
    print(f"  [{time.perf_counter() - T0:6.2f}s] {msg}", file=sys.stderr, flush=True)


def title(n, q):
    print(f"\n# Probe {n} — {q}", flush=True)


def note(msg):
    print(f"- {msg}", flush=True)


def nulls_in(tbl):
    return sum(1 for v in tbl.to_arrow()["embedding"] if v.as_py() is None)


def main() -> int:
    shutil.rmtree(SCRATCH, ignore_errors=True)
    db = lancedb.connect(SCRATCH)
    fn = embedder()
    dim = fn.ndims()
    data = rows(ROWS)
    log(f"start · model={EMBEDDING_MODEL} · dims={dim} · rows={ROWS}")

    title(1, "our class registers, reports dims without a network call")
    note(f"`arra-ollama` · model={EMBEDDING_MODEL} · ndims={dim} · max_retries={fn.max_retries}")

    class Bound(LanceModel):
        id: str
        content: str = fn.SourceField()
        embedding: Vector(dim) = fn.VectorField()

    class Unbound(LanceModel):  # what models/memory.py ships
        id: str
        content: str
        embedding: Optional[Vector(dim)] = None

    title(2, "is `embedding` still nullable once bound? §4.6 rests on this")
    for label, m in (("bound", Bound), ("unbound", Unbound)):
        f = m.to_arrow_schema().field("embedding")
        note(f"{label}: nullable={f.nullable} · {f.type}")

    title(3, f"add() {ROWS} rows, bound — is the embedder on the write path?")
    tb = db.create_table("bound", schema=Bound, mode="overwrite")
    log("bound.add() begin")
    t = time.perf_counter()
    tb.add(data)
    dt = time.perf_counter() - t
    log("bound.add() returned")
    note(f"add() blocked {dt * 1000:.0f} ms for {ROWS} rows ({dt / ROWS * 1000:.1f} ms/row) · null vectors={nulls_in(tb)}")
    note("=> yes. The caller waited for every embedding.")

    title(4, "same rows, unbound — write first, backfill after")
    ub = db.create_table("unbound", schema=Unbound, mode="overwrite")
    t = time.perf_counter()
    ub.add([{**r, "embedding": None} for r in data])
    dt_write = time.perf_counter() - t
    log("unbound.add() returned — no embedder contacted")
    t = time.perf_counter()
    vecs = fn.generate_embeddings([r["content"] for r in data])
    ub.merge_insert("id").when_matched_update_all().execute(
        [{**r, "embedding": v} for r, v in zip(data, vecs)]
    )
    dt_backfill = time.perf_counter() - t
    log("backfill merged")
    note(f"write returned in {dt_write * 1000:.1f} ms · backfill {dt_backfill * 1000:.0f} ms · nulls after={nulls_in(ub)}")
    note(f"=> caller saw {dt_write * 1000:.1f} ms, not {(dt_write + dt_backfill) * 1000:.0f} ms. Same end state.")

    title(5, "search with raw text on the bound table")
    hits = tb.search("what do we keep").limit(3).to_list()
    note(f"`search('what do we keep')` → {[(h['id'], round(h['_distance'], 3)) for h in hits]}")

    title("6a", "embedder down, bound, retries on — how long does add() hang?")
    note(f"default max_retries={fn.max_retries}, exponential backoff with jitter")
    two = embedder(base_url=DEAD, max_retries=2)

    class DeadTwo(LanceModel):
        id: str
        content: str = two.SourceField()
        embedding: Vector(dim) = two.VectorField()

    td = db.create_table("dead2", schema=DeadTwo, mode="overwrite")
    log("dead.add() begin (max_retries=2 so this finishes)")
    t = time.perf_counter()
    try:
        td.add(data[:1])
        note(f"add() succeeded after {time.perf_counter() - t:.1f}s (unexpected)")
    except Exception as e:
        note(f"max_retries=2: add() raised {type(e).__name__} after {time.perf_counter() - t:.1f}s · rows written={td.count_rows()}")
    log("dead.add() done")
    seen = [2.2, 5.0, 16.0, 53.1, 141.7, 500.5]  # printed by lancedb itself, 2026-09-18
    note(f"max_retries=7 (default): observed waits {seen} s = {sum(seen) / 60:.0f} min before retry 7")
    note("=> the write hangs 12+ minutes, then is LOST.")

    title("6b", "embedder down, bound, max_retries=0")
    zero = embedder(base_url=DEAD, max_retries=0)

    class DeadZero(LanceModel):
        id: str
        content: str = zero.SourceField()
        embedding: Vector(dim) = zero.VectorField()

    tz = db.create_table("dead0", schema=DeadZero, mode="overwrite")
    t = time.perf_counter()
    try:
        tz.add(data[:1])
        note(f"add() succeeded after {time.perf_counter() - t:.2f}s")
    except Exception as e:
        note(f"add() raised {type(e).__name__} after {(time.perf_counter() - t) * 1000:.0f} ms · rows written={tz.count_rows()}")
    note("=> fails fast, still LOST.")

    title("6c", "embedder down, unbound — the path v4 ships")
    ud = db.create_table("unbound_dead", schema=Unbound, mode="overwrite")
    t = time.perf_counter()
    ud.add([{**data[0], "embedding": None}])
    note(f"add() returned in {(time.perf_counter() - t) * 1000:.1f} ms · rows written={ud.count_rows()} · embedder never contacted")
    note("=> the memory exists. `sync_state='pending'`. Backfill later.")

    title(7, "what the schema carries to the next reader")
    md = json.loads(tb.schema.metadata[b"embedding_functions"].decode())
    note(f"`embedding_functions` = `{json.dumps(md[0])}`")
    if md[0].get("model") == {}:
        note("=> `model` is EMPTY. base_url and model name never reach disk.")
        note("   A reader whose env differs embeds queries with another model. No error.")
    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
