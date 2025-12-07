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
        raise HTTPException(
            status_code=400, detail="node_id is required for least-similar recommendation"
        )

    try:
        from utils.tenant_utils import ensure_tenant_exists_and_set
        await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

        COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")
        coll = await chroma_client.get_collection(COLLECTION_NAME)

        # 1) get query embedding
        try:
            data = await coll.get(ids=[node_id], include=["embeddings"])
        except Exception as e:
            logger.warning("least_similar: failed to fetch embedding for %s: %s", node_id, e)
            return []
        embs = data.get("embeddings", []) if data else []
        if len(embs) == 0 or embs[0] is None or len(embs[0]) == 0:
            logger.warning("least_similar: embedding for node_id %s not found", node_id)
            return []
        query_emb = np.array(embs[0], dtype=np.float32)

        # 2) get all ids (기본 get은 최대 10개만 반환하므로 limit=None로 전체 조회)
        all_data = await coll.get(limit=None)
        all_ids = all_data.get("ids", []) if all_data else []
        logger.info(
            "least_similar: total ids=%s (query=%s)", len(all_ids), node_id
        )

        # remove the query id
        pool_ids = [str(i) for i in (all_ids or []) if str(i) != str(node_id)]
        logger.info("least_similar: pool size=%s", len(pool_ids))
        if not pool_ids:
            return []

        # 3) sample candidate ids (풀 전체가 작으면 전부 사용)
        dynamic_sample = max(top_k * 5, 20)
        sample_size = min(len(pool_ids), max(sample_size, dynamic_sample))
        if len(pool_ids) <= sample_size:
            sampled = pool_ids
        else:
            sampled = random.sample(pool_ids, sample_size)

        # 4) fetch ids and embeddings for sampled ids
        # ids are always returned by default
        samples = await coll.get(ids=sampled, include=["embeddings"])
        sample_ids = samples.get("ids", []) if samples else []
        sample_embs = samples.get("embeddings", []) if samples else []
        logger.info(
            "least_similar: fetched samples ids=%s embs=%s", len(sample_ids), len(sample_embs)
        )

        # simple chroma assumption: sample_embs is list[list[float]] aligned with sample_ids
        if len(sample_embs) == 0:
            return []

        # build numpy array (n_candidates, dim)
        try:
            arr = np.asarray(sample_embs, dtype=np.float32)
        except Exception as e:
            logger.warning("least_similar: failed to cast embeddings (%s), fallback to ids", e)
            return list(sample_ids)[:top_k]

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

        if not recommendations:
            logger.warning("least_similar: similarity empty, fallback to sampled ids")
            return [{"id": sid, "score": None} for sid in sample_ids[:top_k]]

        return recommendations

    except HTTPException:
        raise
    except Exception as e:
        logger.warning("Least-similar recommendation failed: %s", e)
        return []
