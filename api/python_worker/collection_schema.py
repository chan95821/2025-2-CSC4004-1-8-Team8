"""Collection document schema and helpers for Chroma documents.

This module defines Pydantic models for node and edge metadata and
provides helpers to build/validate documents to be stored in the Chroma
collection. It also exposes a small helper to compute an edge embedding
as the element-wise difference between two node embeddings.

Design decisions:
- Do not rely on Chroma to enforce metadata schema; validate in Python
  using Pydantic before inserting documents.
- Each document's metadata includes a `type` field: either "node" or
  "edge", so queries can easily filter on this.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple, Union, Literal
import numpy as np
from pydantic import BaseModel, field_validator


class NodeMetadata(BaseModel):
    """Metadata for a graph node.

    Fields:
    - type: fixed to "node"
    - label: human readable label for the node
    - content: optional textual content of the node (used for embedding)
    - extra: free-form dict for additional per-node metadata
    """

    type: Literal["node"] = "node"
    # label removed from metadata; tags/labels are stored in MongoDB and
    # not sent as Chroma metadata to avoid non-primitive types.




class EdgeMetadata(BaseModel):
    """Metadata for a graph edge.

    Fields:
    - type: fixed to "edge"
    - label: human readable label for the edge
    - source_id: id of source node
    - target_id: id of target node
    - extra: free-form dict for additional per-edge metadata
    """

    type: Literal["edge"] = "edge"
    source_id: str
    target_id: str
    label: str


DocumentMetadata = Union[NodeMetadata, EdgeMetadata]


class DocumentRecord(BaseModel):
    """Represents a document record prepared for Chroma.

    - id: unique id for the document in the collection
    - embedding: optional embedding vector (list of floats)
    - metadata: NodeMetadata or EdgeMetadata
    - document: optional textual document field (for text-based retrieval)
    """

    id: str
    embedding: Optional[List[float]] = None
    metadata: DocumentMetadata
    document: Optional[str] = None

    @field_validator("metadata")
    @classmethod
    def metadata_type_must_be_valid(cls, v):
        if not isinstance(v, (NodeMetadata, EdgeMetadata)):
            raise ValueError("metadata must be NodeMetadata or EdgeMetadata")
        return v


def make_node_record(
    id: str,
    content: str,
    # embedding: Optional[List[float]] = None,
) -> DocumentRecord:
    """Build a DocumentRecord for a node."""
    meta = NodeMetadata()
    return DocumentRecord(id=id, metadata=meta, document=content)


def make_edge_record(
    id: str,
    label: str,
    source_id: str,
    target_id: str,
    embedding: Optional[List[float]] = None, # edge record는 vector 계산해서 넣어야
) -> DocumentRecord:
    """Build a DocumentRecord for an edge.

    Note: embedding for an edge is expected to be the element-wise
    difference of the target and source node embeddings (or vice versa,
    depending on desired direction). Use `edge_embedding_from_nodes` to
    compute this prior to creating the record if you have node embeddings.
    """

    # label is stored in metadata for easy querying
    meta = EdgeMetadata(source_id=source_id, target_id=target_id, label=label)
    return DocumentRecord(id=id, embedding=embedding, metadata=meta, document=label)


def edge_embedding_from_nodes(
    source_embedding: List[float], target_embedding: List[float]
) -> List[float]:
    """Compute element-wise difference between two node embeddings.

    Returns target - source (so edge vector points from source -> target).
    Raises ValueError if lengths differ.
    """

    if len(source_embedding) != len(target_embedding):
        raise ValueError("source and target embeddings must be the same length")
    return (np.array(target_embedding) - np.array(source_embedding)).tolist()


def prepare_chroma_payload(records: List[DocumentRecord]) -> Tuple[List[str], List[Optional[str]], List[Optional[List[float]]], List[Dict[str, Any]]]:
    """Convert DocumentRecords into parallel arrays expected by Chroma

    Returns: (ids, documents, embeddings, metadatas)
    - ids: list[str]
    - documents: list[Optional[str]] (may be None)
    - embeddings: list[Optional[list[float]]] (may be None)
    - metadatas: list[dict]
    """

    ids: List[str] = []
    documents: List[Optional[str]] = []
    embeddings: List[Optional[List[float]]] = []
    metadatas: List[Dict[str, Any]] = []

    for r in records:
        ids.append(r.id)
        documents.append(r.document)
        embeddings.append(r.embedding)
        # metadata is a Pydantic model with primitive fields (type, label, etc.)
        # since `extra` was removed, model_dump() should already produce only
        # primitive-friendly values acceptable to Chroma; append directly.
        # exclude None values so fields like 'label' are omitted when not set
        metadatas.append(r.metadata.model_dump(exclude_none=True))

    return ids, documents, embeddings, metadatas


__all__ = [
    "NodeMetadata",
    "EdgeMetadata",
    "DocumentRecord",
    "make_node_record",
    "make_edge_record",
    "edge_embedding_from_nodes",
    "prepare_chroma_payload",
]
