"""AIDriveNote FastAPI application."""
from __future__ import annotations

import asyncio
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
from app.routers.note.asr import router as note_asr_router
from app.routers.note.recordings import router as note_recordings_router
from app.routers.note.email import router as note_email_router
from app.routers.note.title import router as note_title_router
from app.routers.mcp import router as mcp_router
from app.routers.kb import router as kb_router
from app.routers.public import router as public_router
from app.routers.clip import router as clip_router
from app.routers.ingest import router as ingest_router
from app.routers.knowledge import note_router as knowledge_note_router
from app.routers.knowledge import router as knowledge_router
from app.routers.admin.users import router as admin_users_router
from app.routers.admin.guest_events import router as admin_guest_events_router
from app.services.ai.seed_service import AISeedService
from app.services.ai.rag_v2_schema import ensure_rag_schema
from app.services.ai.rag_index_service import run_index_worker
from app.services.knowledge.ingest_worker import run_ingest_worker
from app.services.admin_bootstrap import AdminBootstrap
from app.services.guest_purge_service import GuestPurgeService
import app.ai_tools  # noqa: F401 — register AI tools
import app.models.ai  # noqa: F401 — register AI tables
import app.models.guest_event  # noqa: F401 — register guest_events table
import app.models.mcp  # noqa: F401 — register MCP client tables
import app.models.kb  # noqa: F401 — register KB asset tables
import app.models.knowledge  # noqa: F401 — register knowledge ingest tables

settings = get_settings()
logger = logging.getLogger(__name__)


async def _guest_purge_loop() -> None:
    """周期性清除超时的匿名账号。

    自建而非引入 APScheduler/Celery：清除逻辑轻量、无需独立进程，
    与现有 lifespan 种子初始化风格一致。单次失败只记日志，下一轮继续。
    """
    interval = max(30, int(get_settings().GUEST_PURGE_INTERVAL_SECONDS))
    while True:
        try:
            await asyncio.sleep(interval)
            purged = await GuestPurgeService.purge_offline_guests()
            if purged:
                logger.info("匿名数据清除任务完成，清除 %s 个账号", purged)
        except asyncio.CancelledError:
            # 进程关停时的正常取消，直接退出
            raise
        except Exception:  # noqa: BLE001 — 后台任务不允许异常冒泡
            logger.exception("匿名数据清除任务失败，下一轮重试")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    应用启动 / 关闭钩子。

    启动阶段的种子数据、管理员初始化属于「尽力而为」的准备工作：
    一旦数据库抖动或耗时过长，不应阻断服务启动导致整站不可用。
    因此这里整体兜住异常，只记录日志，保证应用照常接受请求。
    """
    purge_task: asyncio.Task | None = None
    index_task: asyncio.Task | None = None
    ingest_task: asyncio.Task | None = None
    index_stop = asyncio.Event()
    ingest_stop = asyncio.Event()
    if os.getenv("AIDRIVE_TESTING") != "1":
        try:
            async with AsyncSessionLocal() as db:
                await AISeedService.ensure_platform_seed(db)
                await AdminBootstrap.ensure_configured_admin(db)
                await db.commit()
                rag_schema_ready = (
                    settings.RAG_V2_ENABLED and await ensure_rag_schema(db)
                )
        except Exception:  # noqa: BLE001 — 启动阶段不允许异常冒泡阻断服务
            logger.exception("启动初始化（AI 种子数据 / 管理员账号）失败，已跳过，服务继续启动")
            rag_schema_ready = False

        # 匿名数据清除：AIDRIVE_TESTING=1 时不启动，否则测试进程会被 sleep 永久挂起
        if get_settings().GUEST_LOGIN_ENABLED:
            purge_task = asyncio.create_task(_guest_purge_loop())
        # RAG v2 索引 worker：pgvector 就绪时消费索引任务；否则不启动
        if rag_schema_ready:
            index_task = asyncio.create_task(run_index_worker(index_stop))
        # 知识入库 worker：解析 → 蒸馏；不依赖 pgvector
        if settings.KNOWLEDGE_INGEST_ENABLED:
            ingest_task = asyncio.create_task(run_ingest_worker(ingest_stop))
    try:
        yield
    finally:
        if purge_task is not None:
            purge_task.cancel()
            # 等待取消完成，避免关停时任务还在读写数据库
            await asyncio.gather(purge_task, return_exceptions=True)
        if index_task is not None:
            index_stop.set()
            index_task.cancel()
            await asyncio.gather(index_task, return_exceptions=True)
        if ingest_task is not None:
            ingest_stop.set()
            ingest_task.cancel()
            await asyncio.gather(ingest_task, return_exceptions=True)


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
app.include_router(admin_guest_events_router, prefix=API_PREFIX)
app.include_router(note_router, prefix=API_PREFIX)
app.include_router(note_email_router, prefix=API_PREFIX)
app.include_router(note_title_router, prefix=API_PREFIX)
app.include_router(note_recordings_router, prefix=API_PREFIX)
app.include_router(note_asr_router, prefix=API_PREFIX)
app.include_router(ai_router, prefix=API_PREFIX)
app.include_router(mcp_router, prefix=API_PREFIX)
app.include_router(kb_router, prefix=API_PREFIX)
app.include_router(public_router, prefix=API_PREFIX)
app.include_router(clip_router, prefix=API_PREFIX)
app.include_router(ingest_router, prefix=API_PREFIX)
app.include_router(knowledge_router, prefix=API_PREFIX)
app.include_router(knowledge_note_router, prefix=API_PREFIX)


@app.exception_handler(AppException)
async def app_exception_handler(_request, exc: AppException):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.APP_NAME}
