"""AIDriveNote FastAPI application."""
from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import engine, Base, AsyncSessionLocal
from app.exceptions import AppException
from app.routers.auth import router as auth_router
from app.routers.users import router as users_router
from app.routers.ai import router as ai_router
from app.routers.note.note import router as note_router
from app.services.ai.seed_service import AISeedService
import app.ai_tools  # noqa: F401 — register AI tools
import app.models.ai  # noqa: F401 — register AI tables

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.getenv("AIDRIVE_TESTING") != "1":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with AsyncSessionLocal() as db:
            await AISeedService.ensure_platform_seed(db)
    yield


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api/v1"
app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(users_router, prefix=API_PREFIX)
app.include_router(note_router, prefix=API_PREFIX)
app.include_router(ai_router, prefix=API_PREFIX)


@app.exception_handler(AppException)
async def app_exception_handler(_request, exc: AppException):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.APP_NAME}
