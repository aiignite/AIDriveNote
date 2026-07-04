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
import app.models.note.note  # noqa: F401
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

    async def _dispose() -> None:
        await engine.dispose()
        from app.database import engine as app_engine

        await app_engine.dispose()
        try:
            from tests.test_note_router import note_test_engine

            await note_test_engine.dispose()
        except Exception:
            pass

    try:
        asyncio.run(_dispose())
    except RuntimeError:
        pass
