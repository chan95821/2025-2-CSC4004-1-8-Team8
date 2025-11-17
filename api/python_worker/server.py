#!/usr/bin/env python3
"""
FastAPI server to compute embeddings.

Endpoints:
 - GET /health -> 200 OK
 - POST /embed -> accepts JSON {"id":..., "text":...} or [{...}, ...]
   returns embeddings as JSON

Run (development):
  uvicorn api.python_worker.server:app --host 0.0.0.0 --port 8000 --reload

Or via gunicorn/uvicorn in production.
"""

import os
import sys
import logging
import asyncio
from dotenv import load_dotenv

from fastapi import FastAPI
from contextlib import asynccontextmanager

logger = logging.getLogger("librechat.server")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


# Load env from repo root .env when available (same behavior as other modules)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
DOTENV_PATH = os.path.join(ROOT, ".env")
if os.path.exists(DOTENV_PATH):
    if os.path.exists(DOTENV_PATH):
        load_dotenv(DOTENV_PATH)
    else:
        print(f".env not found at {DOTENV_PATH}")

# Connection config
MONGO_URI = os.environ.get("MONGO_URI")
CHROMA_HOST = os.environ.get("CHROMA_HOST", "localhost")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8080"))
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize and cache DB / Chroma clients on app start
    try:
        import pymongo
        app.state.mongo_client = pymongo.AsyncMongoClient(MONGO_URI) if MONGO_URI else None
        if app.state.mongo_client:
            # verify connectivity; if ping fails, exit immediately
            try:
                await app.state.mongo_client.admin.command("ping")
            except Exception as e:
                logger.error("Failed to ping MongoDB at startup: %s", e)
                sys.exit(1)
            app.state.kgraph_collection = app.state.mongo_client.get_default_database()["kgraphs"]
    except Exception as e:
        logger.warning("Failed to initialize MongoClient in startup: %s", e)

    try:
        import chromadb
        # prefer AsyncHttpClient for REST chroma server in async FastAPI
        try:
            # Async client must be awaited to instantiate
            app.state.chroma = await chromadb.AsyncHttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
            # perform a lightweight async health check; prefer list_collections
            # which most Chroma HTTP servers implement. If this fails, exit.
            try:
                # list_collections is expected to be async for AsyncHttpClient
                await app.state.chroma.list_collections()
            except Exception as e:
                logger.error("Failed to contact remote Chroma server at %s:%s: %s", CHROMA_HOST, CHROMA_PORT, e)
                sys.exit(1)
        except Exception as e:
            logger.error("Failed to initialize Chroma AsyncHttpClient: %s", e)
            sys.exit(1)

        # Initialize AdminClient for tenant management using documented Settings-based API
        try:
            from chromadb.config import Settings

            settings = Settings(
                chroma_api_impl="chromadb.api.fastapi.FastAPI",
                chroma_server_host=CHROMA_HOST,
                chroma_server_http_port=str(CHROMA_PORT),
            )
            app.state.chroma_admin = chromadb.AdminClient(settings=settings)
            logger.info("Initialized chroma AdminClient with Settings(host=%s, port=%s)", CHROMA_HOST, CHROMA_PORT)
        except Exception as e:
            # Fallback: try default no-arg AdminClient
            try:
                app.state.chroma_admin = chromadb.AdminClient()
                logger.info("Initialized chroma AdminClient with default constructor")
            except Exception as e2:
                logger.warning("Failed to initialize Chroma AdminClient: %s ; fallback error: %s", e, e2)
    except Exception as e:
        logger.warning("Failed to initialize Chroma client in startup: %s", e)

    yield 

    # Shutdown: clean up clients
    try:
        mc = getattr(app.state, "mongo_client", None)
        if mc:
            mc.close()
    except Exception:
        pass
    try:
        chroma = getattr(app.state, "chroma", None)
        if chroma:
            # try graceful reset/close if available
            try:
                reset = getattr(chroma, "reset", None)
                if reset:
                    if asyncio.iscoroutinefunction(reset):
                        await reset()
                    else:
                        reset()
            except Exception:
                pass
    except Exception:
        pass


app = FastAPI(title="LibreChat Embedding Server", lifespan=lifespan)

# Include routers
from routes.health import router as health_router
from routes.embed import router as embed_router
from routes.umap import router as umap_router
from routes.recommendation import router as recommendation_router

app.include_router(health_router)
app.include_router(embed_router)
app.include_router(umap_router)
app.include_router(recommendation_router)


if __name__ == "__main__":
    # Simple dev server when executed directly
    import uvicorn

    # When running the script directly (python server.py) the package
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)
