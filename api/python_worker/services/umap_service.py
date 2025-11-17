import asyncio
import logging
from typing import List, Dict, Any, Tuple

import numpy as np
from chromadb.api import AsyncClientAPI

try:
    import umap
except Exception:
    umap = None

logger = logging.getLogger("librechat.server")


async def calculate_umap_coordinates(
    chroma_client: AsyncClientAPI,
    user_id: str,
    collection_name: str,
    n_components: int = 2,
    metric: str = "cosine",
) -> List[Dict[str, Any]]:
    """
    Calculate UMAP coordinates for all user's node embeddings.

    This is a CPU-bound operation that runs in a thread pool to avoid
    blocking the event loop.

    Args:
        chroma_client: Async Chroma client
        user_id: User ID for tenant isolation
        collection_name: Chroma collection name
        n_components: Number of dimensions to reduce to (default: 2)
        metric: Distance metric for UMAP (default: "cosine")

    Returns:
        List of dicts with {id, x, y} coordinates

    Raises:
        Exception: If embeddings fetch or UMAP computation fails
    """
    if umap is None:
        raise RuntimeError("umap-learn is not installed")

    # 1. Fetch all embeddings from Chroma
    ids_list, embs_arr = await _fetch_all_embeddings(chroma_client, collection_name, user_id)

    if not ids_list or embs_arr is None or len(embs_arr) == 0:
        logger.warning(f"[UMAP] No embeddings found for user {user_id}")
        return []

    # 2. Run UMAP in thread pool (CPU-bound operation)
    coords = await _run_umap_in_thread(embs_arr, n_components, metric)

    # 3. Format response
    response = _format_coordinates(ids_list, coords)

    logger.info(f"[UMAP] Coordinates calculated for {len(response)} nodes (userId: {user_id})")
    return response


async def _fetch_all_embeddings(
    chroma_client: AsyncClientAPI,
    collection_name: str,
    user_id: str,
) -> Tuple[List[str], np.ndarray]:
    """
    Fetch all embeddings from Chroma for a tenant.

    Args:
        chroma_client: Async Chroma client
        collection_name: Collection name
        user_id: User ID for tenant isolation

    Returns:
        Tuple of (ids_list, embeddings_array)
    """
    await chroma_client.set_tenant(user_id)
    coll = await chroma_client.get_collection(collection_name)

    # ids are always returned by default, only request embeddings
    docs = await coll.get(include=["embeddings"])

    ids_list = docs.get("ids") or []
    embs_arr = docs.get("embeddings")  # 2D numpy array

    return ids_list, embs_arr


async def _run_umap_in_thread(
    embeddings: np.ndarray,
    n_components: int,
    metric: str,
) -> np.ndarray:
    """
    Run UMAP fit_transform in a thread pool to avoid blocking.

    Args:
        embeddings: 2D array of embeddings
        n_components: Number of output dimensions
        metric: Distance metric

    Returns:
        2D array of UMAP coordinates

    Raises:
        Exception: If UMAP computation fails
    """
    reducer = umap.UMAP(n_components=n_components, metric=metric)

    try:
        # CPU-bound operation delegated to thread pool
        coords = await asyncio.to_thread(reducer.fit_transform, embeddings)
        return coords
    except Exception as e:
        logger.exception(f"[UMAP] Fit-transform failed: {e}")
        raise


def _format_coordinates(ids_list: List[str], coords: np.ndarray) -> List[Dict[str, Any]]:
    """
    Format UMAP coordinates into response structure.

    Args:
        ids_list: List of node IDs
        coords: 2D array of coordinates (n_samples, n_components)

    Returns:
        List of {id, x, y} dicts
    """
    response = []
    for id_str, (x, y) in zip(ids_list, coords.tolist()):
        response.append({"id": str(id_str), "x": float(x), "y": float(y)})
    return response
