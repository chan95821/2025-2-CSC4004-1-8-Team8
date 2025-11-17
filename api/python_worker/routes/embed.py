import os
import logging
from typing import List, Optional, Dict, Any

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel

from chromadb.utils.embedding_functions import OpenAIEmbeddingFunction
from collection_schema import make_node_record, prepare_chroma_payload, make_edge_record, edge_embedding_from_nodes

from models import NodeItem
from utils.tenant_utils import ensure_tenant_exists_and_set

logger = logging.getLogger("librechat.server")

router = APIRouter()


class EmbedRequest(BaseModel):
    user_id: str
    nodes: List[NodeItem]


class DocumentsResult(BaseModel):
    ids: List[str]
    documents: List[Optional[str]]
    metadatas: Optional[List[Dict[str, Any]]] = None
    embeddings: Optional[List[Optional[List[float]]]] = None


class DeleteRequest(BaseModel):
    user_id: str
    ids: List[str]


class EdgeEmbedRequest(BaseModel):
    user_id: str
    edges: List[Dict[str, str]]  # Each edge: {"id": "unique_id", "source_id": "...", "target_id": "...", "label": "..."}


def get_chroma_client(http_request: Request):
    return http_request.app.state.chroma


def get_admin_client(http_request: Request):
    return http_request.app.state.chroma_admin


@router.post("/embed/node", response_model=DocumentsResult)
async def embed_node(
    req: EmbedRequest,
    chroma_client=Depends(get_chroma_client),
    admin_client=Depends(get_admin_client)
):
    """Embed and store nodes in Chroma.
    - Insert와 Update를 모두 처리 가능
    - Creates new embeddings if ID doesn't exist
    - Updates existing embeddings and documents if ID exists
    - Automatically recomputes embeddings from documents
    - When nodes are updated, automatically recalculates related edge embeddings
    """
    nodes = req.nodes
    user_id = req.user_id

    if not nodes:
        return DocumentsResult(ids=[], documents=[], embeddings=[], metadatas=[])

    # Set tenant to user_id for isolation, create if not exists
    await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

    # Get or create collection per tenant
    COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")
    chroma_collection = await chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        embedding_function=OpenAIEmbeddingFunction(
            api_key=os.environ.get("OPENAI_API_KEY"),
            model_name="text-embedding-3-small"
        ),
        configuration={"hnsw": {"space": "cosine", "ef_construction": 200}},
    )

    # Prepare records for Chroma
    records = []
    for node in nodes:
        record = make_node_record(
            id=node.id,
            content=node.content,
        )
        records.append(record)

    # Prepare payload for Chroma (without embeddings, let Chroma compute them)
    ids, documents, _, _ = prepare_chroma_payload(records)

    # Upsert to Chroma: updates if ID exists, adds if ID doesn't exist
    # When documents are provided without embeddings, Chroma recomputes embeddings
    await chroma_collection.upsert(
        ids=ids,
        documents=documents,
    )

    # Retrieve the just-upserted nodes
    node_data = await chroma_collection.get(ids=ids, include=["documents", "embeddings"])

    # Find and recalculate edges affected by these node updates
    # Query edges where source_id or target_id matches any of the updated node IDs
    updated_node_ids = set(ids)
    
    try:
        # Find edges with source_id in updated nodes
        edges_as_source = await chroma_collection.get(
            where={"source_id": {"$in": list(updated_node_ids)}},
            include=["metadatas", "documents", "embeddings"]
        )
    except Exception as e:
        logger.warning("Could not query edges as source: %s", str(e))
        edges_as_source = {"ids": [], "metadatas": [], "documents": [], "embeddings": []}

    try:
        # Find edges with target_id in updated nodes
        edges_as_target = await chroma_collection.get(
            where={"target_id": {"$in": list(updated_node_ids)}},
            include=["metadatas", "documents", "embeddings"]
        )
    except Exception as e:
        logger.warning("Could not query edges as target: %s", str(e))
        edges_as_target = {"ids": [], "metadatas": [], "documents": [], "embeddings": []}

    # Merge and deduplicate affected edge IDs
    affected_edge_ids = set(edges_as_source.get("ids", []) + edges_as_target.get("ids", []))
    
    if affected_edge_ids:
        # Retrieve all affected edges with their full metadata
        affected_edges_data = await chroma_collection.get(
            ids=list(affected_edge_ids),
            include=["metadatas", "documents"]
        )

        # Build maps for quick lookup
        node_embeddings = {}
        for node_id, emb in zip(node_data.get("ids", []), node_data.get("embeddings", [])):
            if emb is not None:
                node_embeddings[node_id] = emb

        # Recalculate edge embeddings
        edge_ids_to_update = []
        edge_embeddings_to_update = []
        edge_metadatas_to_update = []
        edge_documents_to_update = []

        for edge_id, metadata, document in zip(
            affected_edges_data.get("ids", []),
            affected_edges_data.get("metadatas", []),
            affected_edges_data.get("documents", [])
        ):
            source_id = metadata.get("source_id")
            target_id = metadata.get("target_id")
            label = metadata.get("label", "")

            # Skip if source or target not in updated nodes (shouldn't happen but be safe)
            if source_id not in updated_node_ids and target_id not in updated_node_ids:
                continue

            # Skip if we don't have both node embeddings
            if source_id not in node_embeddings or target_id not in node_embeddings:
                logger.warning("Skipping edge %s: missing node embedding", edge_id)
                continue

            # Recalculate displacement vector
            source_emb = node_embeddings[source_id]
            target_emb = node_embeddings[target_id]
            displacement = edge_embedding_from_nodes(source_emb, target_emb)

            edge_ids_to_update.append(edge_id)
            edge_embeddings_to_update.append(displacement)
            edge_metadatas_to_update.append(metadata)
            edge_documents_to_update.append(document)

        # Upsert updated edges
        if edge_ids_to_update:
            await chroma_collection.upsert(
                ids=edge_ids_to_update,
                embeddings=edge_embeddings_to_update,
                metadatas=edge_metadatas_to_update,
                documents=edge_documents_to_update
            )
            logger.info("Updated %d edge embeddings after node update", len(edge_ids_to_update))

    return DocumentsResult(
        ids=node_data.get("ids", []),
        documents=node_data.get("documents", []),
        embeddings=node_data.get("embeddings", []),
    )


@router.post("/embed/delete")
async def delete_vectors(
    req: DeleteRequest,
    chroma_client=Depends(get_chroma_client),
    admin_client=Depends(get_admin_client),
):
    """Delete vectors from the tenant-scoped Chroma collection by id list.
    - Deletes both nodes and edges by their IDs
    - Does not automatically delete related edges when nodes are deleted
      (MongoDB is responsible for managing node/edge consistency)
    """
    user_id = req.user_id
    ids = req.ids or []

    if not ids:
        return {"deleted": 0}

    # Ensure tenant exists / is selected
    await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

    COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")
    chroma_collection = await chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        embedding_function=OpenAIEmbeddingFunction(
            api_key=os.environ.get("OPENAI_API_KEY"),
            model_name="text-embedding-3-small",
        ),
        configuration={"hnsw": {"space": "cosine", "ef_construction": 200}},
    )

    # Chroma client: delete by ids
    try:
        await chroma_collection.delete(ids=ids)
    except Exception as e:
        logger.error("failed deleting vectors from chroma: %s", getattr(e, 'message', str(e)))
        raise HTTPException(status_code=500, detail="failed deleting vectors")

    return {"deleted": len(ids)}


@router.post("/embed/edge", response_model=DocumentsResult)
async def embed_edge(
    req: EdgeEmbedRequest,
    chroma_client=Depends(get_chroma_client),
    admin_client=Depends(get_admin_client)
):
    """Calculate and store edge embeddings as displacement vectors between node pairs.
    - Receives list of edges with unique IDs
    - Retrieves embeddings for source and target nodes
    - Calculates displacement: target_embedding - source_embedding
    - Stores edge embeddings directly in Chroma with metadata (source_id, target_id, label)
    """
    user_id = req.user_id
    edges = req.edges or []

    if not edges:
        return DocumentsResult(ids=[], documents=[], embeddings=[], metadatas=[])

    # Set tenant to user_id for isolation, create if not exists
    await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

    # Get or create collection per tenant
    COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")
    chroma_collection = await chroma_client.get_or_create_collection(
        name=COLLECTION_NAME,
        embedding_function=OpenAIEmbeddingFunction(
            api_key=os.environ.get("OPENAI_API_KEY"),
            model_name="text-embedding-3-small"
        ),
        configuration={"hnsw": {"space": "cosine", "ef_construction": 200}},
    )

    # Collect all unique source and target IDs
    node_ids = set()
    for edge in edges:
        node_ids.add(edge.get("source_id"))
        node_ids.add(edge.get("target_id"))
    
    node_ids = list(node_ids)

    # Retrieve all node embeddings in one call
    try:
        node_data = await chroma_collection.get(
            ids=node_ids,
            include=["embeddings"]
        )
    except Exception as e:
        logger.error("Failed to retrieve node embeddings: %s", str(e))
        raise HTTPException(status_code=404, detail=f"Could not retrieve embeddings for nodes")

    # Build a map of node_id -> embedding
    node_embeddings = {}
    retrieved_ids = node_data.get("ids", [])
    retrieved_embeddings = node_data.get("embeddings", [])
    
    for node_id, emb in zip(retrieved_ids, retrieved_embeddings):
        if emb is not None:
            node_embeddings[node_id] = emb

    # Calculate displacement vectors for each edge and prepare records
    edge_records = []
    
    for edge in edges:
        edge_id = edge.get("id")
        source_id = edge.get("source_id")
        target_id = edge.get("target_id")
        label = edge.get("label", "")
        
        if not edge_id or not source_id or not target_id:
            logger.warning("Skipping edge with missing fields: %s", edge)
            continue
        
        if source_id not in node_embeddings or target_id not in node_embeddings:
            logger.warning("Skipping edge %s: source or target embedding not found", edge_id)
            continue
        
        source_emb = node_embeddings[source_id]
        target_emb = node_embeddings[target_id]
        
        # Calculate displacement: target - source
        displacement = edge_embedding_from_nodes(source_emb, target_emb)
        
        # Create edge record using make_edge_record
        record = make_edge_record(
            id=edge_id,
            label=label,
            source_id=source_id,
            target_id=target_id,
            embedding=displacement
        )
        edge_records.append(record)
    
    if not edge_records:
        raise HTTPException(status_code=400, detail="No valid edges to embed after validation")

    # Prepare payload for Chroma
    ids, documents, embeddings, metadatas = prepare_chroma_payload(edge_records)

    # Store all edge embeddings
    await chroma_collection.upsert(
        ids=ids,
        embeddings=embeddings,
        documents=documents,
        metadatas=metadatas
    )

    # Retrieve the stored edges
    result = await chroma_collection.get(
        ids=ids,
        include=["documents", "embeddings"]
    )

    return DocumentsResult(
        ids=result.get("ids", []),
        documents=result.get("documents", []),
        embeddings=result.get("embeddings", [])
    )