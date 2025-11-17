import os
import logging
from typing import List, Optional

from chromadb.api import AsyncClientAPI
from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel

import numpy as np

from services.umap_service import calculate_umap_coordinates
from utils.tenant_utils import ensure_tenant_exists_and_set

logger = logging.getLogger("librechat.server")

router = APIRouter()


def get_chroma_client(http_request: Request):
    return http_request.app.state.chroma


def get_admin_client(http_request: Request):
    return http_request.app.state.chroma_admin


def get_kgraph_collection(http_request: Request):
    return http_request.app.state.kgraph_collection


class UMAPRequest(BaseModel):
    user_id: str


@router.post("/calculate-umap")
async def calculate_umap(
    req: UMAPRequest,
    chroma_client=Depends(get_chroma_client),
    admin_client=Depends(get_admin_client),
    kgraph_col=Depends(get_kgraph_collection),
):
    """
    Calculate and update UMAP coordinates for user's knowledge graph.

    Request Body:
        - user_id: User identifier

    Response:
        - List of {id, x, y} coordinates for each node

    Process:
        1. Validate user and set tenant for Chroma
        2. Fetch all embeddings from Chroma
        3. Calculate UMAP coordinates (in thread pool)
        4. Update MongoDB with new coordinates
        5. Return updated coordinates
    """
    user_id = req.user_id
    if not user_id:
        raise HTTPException(status_code=400, detail="Missing user_id in request body")

    # Set tenant for Chroma, create if not exists
    await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

    # Get Chroma collection name from environment
    chroma_collection = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")

    try:
        # Calculate UMAP coordinates using service
        coords_data = await calculate_umap_coordinates(
            chroma_client=chroma_client,
            user_id=user_id,
            collection_name=chroma_collection,
            n_components=2,
            metric="cosine",
        )
    except Exception as e:
        logger.exception(f"[UMAP] Calculation failed: {e}")
        raise HTTPException(status_code=500, detail="UMAP calculation failed")

    # Update MongoDB with new coordinates
    try:
        await _update_mongodb_coordinates(kgraph_col, coords_data)
    except Exception as e:
        logger.exception(f"[UMAP] MongoDB update failed: {e}")
        raise HTTPException(status_code=500, detail="MongoDB update failed")

    return coords_data


async def _update_mongodb_coordinates(kgraph_col, coords_data: List[dict]) -> None:
    """
    Update MongoDB nodes with new UMAP coordinates.

    Args:
        kgraph_col: MongoDB collection
        coords_data: List of {id, x, y} dicts

    Raises:
        Exception: If MongoDB operation fails
    """
    from bson import ObjectId
    from pymongo import UpdateOne

    updates = []
    for item in coords_data:
        try:
            node_id = ObjectId(item["id"])
        except Exception:
            node_id = str(item["id"])

        filter_q = {"nodes._id": node_id}
        update_q = {"$set": {"nodes.$.x": float(item["x"]), "nodes.$.y": float(item["y"])}}
        updates.append(UpdateOne(filter_q, update_q))

    if not updates:
        raise ValueError("No updatable nodes found")

    result = await kgraph_col.bulk_write(updates)
    logger.info(f"[UMAP] MongoDB updated: {result.modified_count} documents")

