import logging
from typing import Optional, Tuple
from fastapi import HTTPException

from chromadb.config import DEFAULT_DATABASE

logger = logging.getLogger("librechat.server")


def get_or_create_tenant_for_user(user_id: str, admin_client) -> Tuple[str, str]:
    """
    Ensure a tenant and database exist for the given user_id using the AdminClient.

    This is intended for deployments where an AdminClient configured with
    REST/fastapi settings manages tenants on a remote Chroma server.

    Returns (tenant_id, database_name).
    """
    try:
        admin_client.get_tenant(user_id)
    except Exception:
        # tenant missing -> create tenant and default database
        admin_client.create_tenant(user_id)
        admin_client.create_database(DEFAULT_DATABASE, user_id)
    return user_id, DEFAULT_DATABASE


async def ensure_tenant_exists_and_set(chroma_client, admin_client: Optional[object], user_id: str):
    """
    Set the chroma_client to use the tenant for the given user_id.

    If the tenant does not exist, use `admin_client` to create the tenant and
    a default database, then set the tenant on the async chroma client.
    """
    try:
        # Try the common case: tenant already exists and can be set directly
        await chroma_client.set_tenant(user_id)
        return
    except Exception as e:
        logger.info("Tenant %s does not exist or cannot be set: %s", user_id, e)

    if admin_client is None:
        logger.error("AdminClient not available to create tenant for user %s", user_id)
        raise HTTPException(status_code=500, detail=f"Admin client unavailable to create tenant for {user_id}")

    try:
        tenant_id, database = get_or_create_tenant_for_user(user_id, admin_client)
        # After creation, set tenant on the async chroma client
        await chroma_client.set_tenant(tenant_id)
    except Exception as create_e:
        logger.error("Failed to create or set tenant %s: %s", user_id, create_e)
        raise HTTPException(status_code=500, detail=f"Failed to create tenant {user_id}")