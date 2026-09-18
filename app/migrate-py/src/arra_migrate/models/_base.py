"""Shared vocabulary for every model. Import from here, not from lancedb directly,
so a dimension or idiom change lands in one place."""

from datetime import datetime
from typing import Optional

from lancedb.pydantic import LanceModel, Vector

EMBEDDING_DIM = 1024  # mxbai-embed-large and bge-m3 both emit 1024

__all__ = ["LanceModel", "Vector", "EMBEDDING_DIM", "datetime", "Optional"]
