"""Our own LanceDB embedding function, over a local Ollama.

WHY OURS when `get_registry().get("ollama")` already exists: the built-in one
is a different wire call and a different default host than `server/src/embed.ts`
makes. Two embedders that disagree by one flag produce vectors that are silently
incomparable -- the table would hold two populations and nothing would error.
This class makes the Python and TypeScript paths the SAME request by
construction, which is the only way that stays true.

REGISTERED, NOT BOUND. Nothing in `models/` uses SourceField/VectorField, and
§4.6 is why: binding computes the vector synchronously inside `table.add()`, so
`remember` would only be as available as the embedder. Registering the class
costs nothing and makes the bound path available to EXPERIMENTS (`probe.py`)
without putting it on the write path.

Three measured traps live in probe.py (run `uv run arra-probe`):

  1. Bound add() with the embedder DOWN retries 7x with exponential backoff
     (>12 min), then raises. The row is never written. §4.6's "text lands
     first" is impossible on the bound path, not merely slower.
  2. Bound add() with the embedder UP blocked 15.5 ms/row for 25 rows; the
     unbound write returned in 3.3 ms and backfilled to the same end state.
  3. LanceDB persists `{"model": {}}` into schema metadata -- base_url and
     model name DO NOT go to disk. A reader whose env differs embeds queries
     with a different model than the data, and nothing errors.
"""

import os
from typing import List, Optional

import requests
from lancedb.embeddings import TextEmbeddingFunction, register

#: Same env names `server/src/embed.ts` reads, so one export configures both.
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "all-minilm")

#: Declared, not discovered. A probe call at import time would make `import
#: arra_migrate` fail whenever Ollama is down -- including for `--check`, which
#: has no business needing an embedder. Mismatch is caught at write time instead.
EMBEDDING_DIM = int(os.environ.get("EMBEDDING_DIMENSIONS", "384"))

#: What each installed model actually emits, measured 2026-09-18 on m5 via
#: POST /api/embed -- not read off a model card.
KNOWN_DIMS = {
    "all-minilm": 384,            #   46 MB
    "nomic-embed-text": 768,      #  274 MB
    "mxbai-embed-large": 1024,    #  670 MB
    "bge-m3": 1024,               # 1158 MB, multilingual
}


@register("arra-ollama")
class ArraOllama(TextEmbeddingFunction):
    """`POST /api/embed` — byte-identical to the call embed.ts makes."""

    name: str = EMBEDDING_MODEL
    base_url: str = OLLAMA_URL
    _probed: Optional[int] = None

    def ndims(self) -> int:
        return KNOWN_DIMS.get(self.name, EMBEDDING_DIM)

    def generate_embeddings(self, texts) -> List[List[float]]:
        texts = list(texts)
        if not texts:
            return []
        r = requests.post(
            f"{self.base_url}/api/embed",
            json={"model": self.name, "input": texts},
            timeout=60,
        )
        r.raise_for_status()
        vectors = r.json()["embeddings"]
        # embed.ts:22 guards the same way. A model swap that forgets
        # EMBEDDING_DIMENSIONS must fail here, not write a ragged column.
        want = self.ndims()
        bad = next((v for v in vectors if len(v) != want), None)
        if bad is not None:
            raise ValueError(
                f"{self.name} returned {len(bad)} dims, schema expects {want}"
            )
        return vectors


def embedder(**kwargs) -> ArraOllama:
    """One instance, shared by SourceField and VectorField.

    Measured in probe 6 (2026-09-18): when the embedder is down, a BOUND
    add() does not degrade -- it retries 7 times with exponential backoff
    (LanceDB printed waits of 2.2s, 5.0s, 16.0s, 53.1s, 141.7s, 500.5s, more
    than 12 minutes before the 7th), then raises, and the row is NOT written.
    The write is lost. Pass max_retries=0 to fail in 0.00s instead; the row is
    still lost. Only the UNBOUND path lands the row (2.7 ms, embedding NULL).
    """
    from lancedb.embeddings import get_registry

    return get_registry().get("arra-ollama").create(**kwargs)
