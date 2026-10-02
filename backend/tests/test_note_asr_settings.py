"""笔记录音 ASR 设置与常用词库测试。

覆盖：环境默认值兜底、设置 Upsert 与 API Key 加密/掩码保留、
常用词 CRUD，以及 admin 权限依赖。
"""
from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# 注册 PostgreSQL 专用类型到 SQLite 的编译器
_sqlite_types_path = Path(__file__).parent / "sqlite_types.py"
_spec = importlib.util.spec_from_file_location("_aidrive_sqlite_types", _sqlite_types_path)
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_mod)

from app.exceptions import ForbiddenException  # noqa: E402
from app.models.note.asr import NoteAsrSettings, NoteCommonTerm  # noqa: E402
from app.models.user import User  # noqa: E402
from app.routers.note.asr import _build_settings_out  # noqa: E402
from app.services.note.recording import (  # noqa: E402
    NoteAsrSettingsService,
    NoteCommonTermService,
)
from app.services.note.recording.secret_crypto import (  # noqa: E402
    MASKED_SECRET_PLACEHOLDER,
    decrypt_secret,
)

ASR_TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
asr_test_engine = create_async_engine(ASR_TEST_DB_URL, echo=False)
AsrTestSession = async_sessionmaker(asr_test_engine, class_=AsyncSession, expire_on_commit=False)

_TABLES = [User, NoteAsrSettings, NoteCommonTerm]


@pytest_asyncio.fixture
async def asr_db() -> AsyncSession:
    """仅创建 ASR 设置与常用词表的最小数据库会话。"""
    async with asr_test_engine.begin() as conn:
        for table in _TABLES:
            await conn.run_sync(lambda sync, t=table: t.__table__.create(sync, checkfirst=True))
    async with AsrTestSession() as session:
        yield session
    async with asr_test_engine.begin() as conn:
        for table in reversed(_TABLES):
            await conn.run_sync(lambda sync, t=table: t.__table__.drop(sync, checkfirst=True))


@pytest.mark.asyncio
async def test_effective_settings_falls_back_to_env(asr_db):
    """无数据库行时，生效设置来自环境变量默认值。"""
    effective = await NoteAsrSettingsService.get_effective_settings(asr_db)

    assert effective["mode"] in {"local", "remote"}
    assert effective["model"]
    assert effective["remote_timeout_seconds"] >= 30


@pytest.mark.asyncio
async def test_save_settings_encrypts_and_masks_api_key(asr_db):
    """保存设置：API Key 加密落库，读取接口只回传掩码。"""
    await NoteAsrSettingsService.save_settings(
        asr_db,
        {
            "mode": "remote",
            "remote_url": "http://192.168.1.10:8090",
            "remote_api_key": "secret-key-123",
            "model": "small",
            "language": "zh",
            "fallback_to_local": True,
        },
        user_name="admin",
    )

    row = await NoteAsrSettingsService.get_settings(asr_db)
    assert row is not None
    # 落库为密文，解密后应还原明文
    assert row.remote_api_key != "secret-key-123"
    assert decrypt_secret(row.remote_api_key) == "secret-key-123"
    assert row.updated_by == "admin"

    out = await _build_settings_out(asr_db)
    assert out["mode"] == "remote"
    assert out["remote_url"] == "http://192.168.1.10:8090"
    assert out["model"] == "small"
    assert out["remote_api_key"] == MASKED_SECRET_PLACEHOLDER


@pytest.mark.asyncio
async def test_save_settings_masked_key_keeps_existing(asr_db):
    """回传掩码占位符时，应保留原有密钥而不覆盖为空。"""
    await NoteAsrSettingsService.save_settings(
        asr_db, {"remote_api_key": "original-key"}, user_name="admin"
    )
    await NoteAsrSettingsService.save_settings(
        asr_db, {"remote_api_key": MASKED_SECRET_PLACEHOLDER}, user_name="admin"
    )

    row = await NoteAsrSettingsService.get_settings(asr_db)
    assert decrypt_secret(row.remote_api_key) == "original-key"


@pytest.mark.asyncio
async def test_common_term_crud(asr_db):
    """常用词库：创建、查询、更新、软删。"""
    created = await NoteCommonTermService.create_term(
        asr_db, {"term": "爱捷云", "alias": "爱捷韵,爱结云", "remark": "专有名词"}, user_name="u1"
    )
    assert created.term == "爱捷云"
    assert created.is_enabled is True

    found = await NoteCommonTermService.list_terms(asr_db, keyword="爱捷")
    assert len(found) == 1

    updated = await NoteCommonTermService.update_term(
        asr_db, created.id, {"term": "爱捷云科技", "is_enabled": False}
    )
    assert updated.term == "爱捷云科技"
    assert updated.is_enabled is False

    # 已禁用词条不出现在「启用词条」列表中
    assert await NoteCommonTermService.list_enabled_terms(asr_db) == []

    assert await NoteCommonTermService.delete_term(asr_db, created.id) is True
    assert await NoteCommonTermService.list_terms(asr_db) == []
    # 重复删除应返回 False
    assert await NoteCommonTermService.delete_term(asr_db, created.id) is False


@pytest.mark.asyncio
async def test_common_term_count_and_filter(asr_db):
    """常用词：关键词过滤与总数统计一致。"""
    await NoteCommonTermService.create_term(asr_db, {"term": "甲词"})
    await NoteCommonTermService.create_term(asr_db, {"term": "乙词"})

    items = await NoteCommonTermService.list_terms(asr_db, keyword="甲")
    total = await NoteCommonTermService.count_terms(asr_db, keyword="甲")
    assert len(items) == 1
    assert total == 1


def test_get_current_admin_permission() -> None:
    """admin 依赖：非管理员抛 Forbidden，管理员放行。"""
    import asyncio

    from app.auth import get_current_admin

    normal = User(email="n@test.com", password_hash="x", name="N")
    normal.role = "user"
    with pytest.raises(ForbiddenException):
        asyncio.run(get_current_admin(normal))

    admin = User(email="a@test.com", password_hash="x", name="A")
    admin.role = "admin"
    assert asyncio.run(get_current_admin(admin)).id == admin.id