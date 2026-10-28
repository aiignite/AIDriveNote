"""Shared pytest fixtures for AIDriveNote backend."""
from __future__ import annotations

import os

os.environ["AIDRIVE_TESTING"] = "1"

import importlib.util
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base, get_db

# Register PostgreSQL → SQLite type compilers for in-memory tests
_sqlite_types_path = Path(__file__).parent / "sqlite_types.py"
_spec = importlib.util.spec_from_file_location("_aidrive_sqlite_types", _sqlite_types_path)
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_mod)

# Register ORM models on Base.metadata before create_all
import app.ai_tools  # noqa: F401 — register AI tools
import app.models.ai.ai  # noqa: F401
import app.models.email_verification  # noqa: F401
import app.models.guest_event  # noqa: F401 — 匿名登录事件表
import app.models.note.note  # noqa: F401
import app.models.note.recording  # noqa: F401 — 录音/转写表（匿名清除测试会涉及）
import app.models.mcp  # noqa: F401 — MCP 客户端表
import app.models.kb  # noqa: F401 — 知识库资产表
import app.models.knowledge  # noqa: F401 — 知识入库/知识卡表
import app.models.user  # noqa: F401

TEST_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(TEST_DATABASE_URL, echo=False)
TestSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def db_session():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with TestSessionLocal() as session:
        yield session
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest_asyncio.fixture
async def test_user(db_session):
    from app.models.user import User

    user = User(email="tools@test.com", password_hash="hash", name="Tools Tester")
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


# 最小笔记 schema（仅 note 相关表）。完整 schema 在 SQLite 下会碰到
# PG 专有类型（TSVECTOR 等）的问题，因此服务层测试单独用这一组表。
note_test_engine = create_async_engine(TEST_DATABASE_URL, echo=False)
NoteTestSession = async_sessionmaker(note_test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def note_db():
    """仅创建 user / folder / note / link / revision 五张表的会话。"""
    import app.models.note.note as note_models
    from app.models.user import User

    tables = [
        User.__table__,
        note_models.NoteFolder.__table__,
        note_models.Note.__table__,
        note_models.NoteLink.__table__,
        note_models.NoteRevision.__table__,
    ]
    async with note_test_engine.begin() as conn:
        for table in tables:
            await conn.run_sync(lambda sync, t=table: t.create(sync, checkfirst=True))

    async with NoteTestSession() as session:
        yield session

    async with note_test_engine.begin() as conn:
        for table in reversed(tables):
            await conn.run_sync(lambda sync, t=table: t.drop(sync, checkfirst=True))


@pytest_asyncio.fixture
async def client(db_session):
    from app.main import app

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Dispose SQLAlchemy pools so pytest exits cleanly."""
    import asyncio
    import sys

    from sqlalchemy.ext.asyncio import AsyncEngine

    # 除 conftest 自带的引擎外，个别测试文件还有模块级引擎
    # （rec_test_engine / asr_test_engine 等）。aiosqlite 连接的工作线程是非
    # daemon 线程，引擎不 dispose 会让解释器在 threading._shutdown 永久挂起，
    # 因此统一扫描已加载模块，把所有 AsyncEngine 一并关闭（dispose 幂等）。
    engines: list[AsyncEngine] = []
    for module in list(sys.modules.values()):
        if module is None:
            continue
        for value in vars(module).values():
            if isinstance(value, AsyncEngine):
                engines.append(value)

    async def _dispose() -> None:
        for eng in engines:
            await eng.dispose()

    try:
        asyncio.run(_dispose())
    except RuntimeError:
        pass
