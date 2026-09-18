"""Shared vocabulary for every model. Import from here, not from lancedb directly,
so a dimension or idiom change lands in one place."""

from datetime import datetime
from typing import Optional

from lancedb.pydantic import LanceModel, Vector

# One source for the dimension, shared with the embedder, so the schema and
# the model that fills it cannot disagree. all-minilm emits 384 (measured
# 2026-09-18). Override both together with EMBEDDING_MODEL + EMBEDDING_DIMENSIONS.
from ..embeddings import EMBEDDING_DIM

__all__ = ["LanceModel", "Vector", "EMBEDDING_DIM", "datetime", "Optional"]
