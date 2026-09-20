"""Shared vocabulary for the ISOLATED target-19 candidate models.

Deliberately NOT importing from ``..models._base``: that module reads the
embedding dimension from the environment so the active runtime can swap models.
The candidate pins its physical shape as a literal instead -- a fixture that
changes shape when an env var changes is not a contract test.
"""

from datetime import datetime
from typing import Optional

from lancedb.pydantic import LanceModel, Vector

# Pinned physical vector shape for search_chunks_v1. This is the physical
# FixedSizeList<Float32, 384> only; the embedding model / profile policy that
# fills it is NOT settled by this constant (DESIGN.md §11).
EMBEDDING_DIM_V1 = 384

__all__ = ["EMBEDDING_DIM_V1", "LanceModel", "Optional", "Vector", "datetime"]
