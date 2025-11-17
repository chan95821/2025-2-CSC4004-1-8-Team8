import os
import logging
import random
from typing import List, Dict, Any, Optional

import numpy as np
from fastapi import HTTPException

logger = logging.getLogger("librechat.server")


async def recommend_least_similar(
    chroma_client,
    admin_client,
    user_id: str,
    node_id: str | None,
    top_k: int = 10,
    sample_size: int = 100,
) -> List[Dict[str, Any]]:
    """Return `top_k` nodes that are least similar to the given node.
    """
    if not node_id:
        raise HTTPException(status_code=400, detail="node_id is required for least-similar recommendation")

    try:
        from utils.tenant_utils import ensure_tenant_exists_and_set
        await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

        COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")
        coll = await chroma_client.get_collection(COLLECTION_NAME)

        # 1) get query embedding
        data = await coll.get(ids=[node_id], include=["embeddings"])
        embs = data.get("embeddings", []) if data else []
        if len(embs) == 0 or embs[0] is None or len(embs[0]) == 0:
            raise HTTPException(status_code=404, detail="Embedding for node_id not found")
        query_emb = np.array(embs[0], dtype=np.float32)

        # 2) get all ids (or rely on get to return ids list)
        # ids are always returned by default, no need to include in 'include' parameter
        all_data = await coll.get()
        all_ids = all_data.get("ids", []) if all_data else []

        # remove the query id
        pool_ids = [str(i) for i in (all_ids or []) if str(i) != str(node_id)]
        if not pool_ids:
            return []

        # 3) sample candidate ids
        if len(pool_ids) <= sample_size:
            sampled = pool_ids
        else:
            sampled = random.sample(pool_ids, sample_size)

        # 4) fetch ids and embeddings for sampled ids
        # ids are always returned by default
        samples = await coll.get(ids=sampled, include=["embeddings"])
        sample_ids = samples.get("ids", []) if samples else []
        sample_embs = samples.get("embeddings", []) if samples else []

        # simple chroma assumption: sample_embs is list[list[float]] aligned with sample_ids
        if not sample_embs:
            return []

        # build numpy array (n_candidates, dim)
        try:
            arr = np.asarray(sample_embs, dtype=np.float32)
        except Exception:
            # if embeddings malformed, bail out
            return []

        # 코사인 유사도 계산
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        arr_norm = arr / np.maximum(norms, 1e-8)

        q = np.asarray(query_emb, dtype=np.float32).ravel()
        q_norm_val = np.linalg.norm(q)
        q_norm = q / max(q_norm_val, 1e-8)
        
        similarity = arr_norm @ q_norm

        # get indices of smallest similarities (most dissimilar)
        k = min(top_k, similarity.shape[0])
        worst_idx = list(np.argsort(similarity)[:k])

        recommendations: List[Dict[str, Any]] = []
        for idx in worst_idx:
            recommendations.append({"id": str(sample_ids[idx]), "score": float(similarity[idx])})

        return recommendations

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Least-similar recommendation failed: %s", e)
        raise HTTPException(status_code=500, detail="Least-similar recommendation failed")
