"""AIDriveNote FastAPI application."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import AsyncSessionLocal
from app.exceptions import AppException
from app.routers.auth import router as auth_router
from app.routers.api_tokens import router as api_tokens_router
from app.routers.users import router as users_router
from app.routers.ai import router as ai_router
from app.routers.note.note import router as note_router
from app.routers.admin.users import router as admin_users_router
from app.services.ai.seed_service import AISeedService
from app.services.admin_bootstrap import AdminBootstrap
import app.ai_tools  # noqa: F401 — register AI tools
import app.models.ai  # noqa: F401 — register AI tables

settings = get_settings()
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    应用启动 / 关闭钩子。

    启动阶段的种子数据、管理员初始化属于「尽力而为」的准备工作：
    一旦数据库抖动或耗时过长，不应阻断服务启动导致整站不可用。
    因此这里整体兜住异常，只记录日志，保证应用照常接受请求。
    """
    if os.getenv("AIDRIVE_TESTING") != "1":
        try:
            async with AsyncSessionLocal() as db:
                await AISeedService.ensure_platform_seed(db)
                await AdminBootstrap.ensure_configured_admin(db)
                await db.commit()
        except Exception:  # noqa: BLE001 — 启动阶段不允许异常冒泡阻断服务
            logger.exception("启动初始化（AI 种子数据 / 管理员账号）失败，已跳过，服务继续启动")
    yield


app = FastAPI(
    title=settings.APP_NAME,
    lifespan=lifespan,
    docs_url="/docs" if settings.API_DOCS_ENABLED else None,
    redoc_url="/redoc" if settings.API_DOCS_ENABLED else None,
    openapi_url="/openapi.json" if settings.API_DOCS_ENABLED else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api/v1"
app.include_router(auth_router, prefix=API_PREFIX)
app.include_router(api_tokens_router, prefix=API_PREFIX)
app.include_router(users_router, prefix=API_PREFIX)
app.include_router(admin_users_router, prefix=API_PREFIX)
app.include_router(note_router, prefix=API_PREFIX)
app.include_router(ai_router, prefix=API_PREFIX)


@app.exception_handler(AppException)
async def app_exception_handler(_request, exc: AppException):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.APP_NAME}
