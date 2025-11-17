import os
import logging
from typing import List, Dict, Any

from fastapi import HTTPException

logger = logging.getLogger("librechat.server")


async def recommend_synonyms(chroma_client, admin_client, user_id: str, node_id: str | None, top_k: int = 10) -> List[Dict[str, Any]]:
    """Use Chroma's native similarity search to return top_k similar node ids.

    This delegates the similarity computation to Chroma. We fetch the embedding for `node_id`
    and ask Chroma for nearest neighbors (including distances). We then filter out the
    original node and return up to `top_k` results.
    """
    if not node_id:
        raise HTTPException(status_code=400, detail="node_id is required for embedding-based recommendation")

    try:
        from utils.tenant_utils import ensure_tenant_exists_and_set
        await ensure_tenant_exists_and_set(chroma_client, admin_client, user_id)

        COLLECTION_NAME = os.environ.get("CHROMA_COLLECTION", "librechat_chroma")
        coll = await chroma_client.get_collection(COLLECTION_NAME)

        # fetch embedding for node_id to use as query
        data = await coll.get(ids=[node_id], include=["embeddings"])
        embs = data.get("embeddings", []) if data else []
        if len(embs) == 0 or embs[0] is None or len(embs[0]) == 0:
            raise HTTPException(status_code=404, detail="Embedding for node_id not found")

        query_emb = embs[0]

        # ask Chroma for nearest neighbors; request distances for scoring
        res = await coll.query(query_embeddings=[query_emb], n_results=top_k + 1, include=["distances"])
        ids = res.get("ids", [[]])[0]
        dists = res.get("distances", [[]])[0]

        recommendations: List[Dict[str, Any]] = []
        for rid, dist in zip(ids, dists):
            if str(rid) == str(node_id):
                continue
            recommendations.append({"id": str(rid), "score": float(dist) if dist is not None else None})
            if len(recommendations) >= top_k:
                break

        return recommendations
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Synonyms embedding recommendation (Chroma) failed: %s", e)
        raise HTTPException(status_code=500, detail="Embedding-based recommendation failed")
