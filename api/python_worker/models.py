from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime


# Node schema compatible with api/models/schema/kgraph.js
class NodeItem(BaseModel):
    """
    NodeItem
    Represents a single node stored in the application database and indexed in Chroma.

    Fields
    - id (str): Unique identifier for the node. Used as the Chroma document id (vector_ref removed; use node.id as Chroma id).
    - label (Optional[str]): Human-readable name or label for the node.
    - x (Optional[float]): X coordinate (if using a spatial/layout representation).
    - y (Optional[float]): Y coordinate (if using a spatial/layout representation).
    - document (str) - REQUIRED: The text content that Chroma will automatically embed. This field must be provided and non-empty; Chroma will create/store the embedding for this text using node.id as the embedding id.
        (document — chroma가 자동으로 임베딩 수행할 텍스트; 반드시 포함되어야 합니다.)
    - createdAt (Optional[datetime]): Creation timestamp. Matches the MongoDB field name "createdAt".
    - updatedAt (Optional[datetime]): Last-updated timestamp. Matches the MongoDB field name "updatedAt".

    Notes
    - Ensure `id` is globally unique for consistent Chroma indexing.
    - `document` is mandatory for vector indexing workflows: Chroma will generate embeddings from this text automatically.
    - Coordinates (`x`, `y`) and `label` are optional metadata to assist UI/layout or search filtering.
    """
    id: str
    content: str
    label: Optional[List[str]] = None
    x: Optional[float] = None
    y: Optional[float] = None
    # Timestamps (match Mongo field names createdAt/updatedAt)
    createdAt: Optional[datetime] = None
    updatedAt: Optional[datetime] = None
    # vector_ref removed: use node.id as the Chroma id