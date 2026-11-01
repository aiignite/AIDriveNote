"""匿名配额与成本保护测试：存储去重、技能上限、蒸馏日限额与模型隔离。"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.exceptions import BadRequestException, ForbiddenException
from app.models.ai import AISkill
from app.models.kb import KbFile, KbRoot
from app.models.note.document import NoteDocument
from app.models.note.note import Note
from app.models.user import User
from app.services.guest_quota_service import GuestQuotaService
from app.services.knowledge.settings_service import KnowledgeSettingsService


def _sha() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


async def _make_user(db: AsyncSession, *, is_guest: bool) -> User:
    user = User(
        email=f"quota-{uuid.uuid4().hex}@test.local",
        password_hash="hash",
        name="匿名" if is_guest else "正式",
        role="guest" if is_guest else "user",
        status="Active",
        is_guest=is_guest,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _add_note_with_document(
    db: AsyncSession, user: User, *, sha: str, size: int,
) -> Note:
    note = Note(
        note_no=f"Q-{uuid.uuid4().hex[:10]}",
        title="文档",
        note_type="document",
        content={"text": "x"},
        created_by=user.id,
    )
    db.add(note)
    await db.flush()
    db.add(NoteDocument(
        note_id=note.id,
        file_name="a.pdf",
        mime="application/pdf",
        ext="pdf",
        size_bytes=size,
        sha256=sha,
        storage_path=f"documents/{sha[:2]}/{sha}.pdf",
        etag="e",
    ))
    return note


async def _add_kb_file(db: AsyncSession, user: User, *, sha: str, size: int) -> None:
    root = KbRoot(user_id=user.id, name="知识库")
    db.add(root)
    await db.flush()
    db.add(KbFile(
        root_id=root.id,
        user_id=user.id,
        path="raw/a.pdf",
        content_hash=sha,
        size=size,
        storage_path=f"documents/{sha[:2]}/{sha}.pdf",
    ))


@pytest.mark.asyncio
async def test_storage_usage_dedupes_note_and_kb_blobs(db_session: AsyncSession):
    guest = await _make_user(db_session, is_guest=True)
    sha = _sha()
    size = 60 * 1024 * 1024
    await _add_note_with_document(db_session, guest, sha=sha, size=size)
    await _add_kb_file(db_session, guest, sha=sha, size=size)
    await db_session.commit()

    assert await GuestQuotaService.storage_usage(db_session, guest.id) == size


@pytest.mark.asyncio
async def test_guest_storage_limit_blocks_and_regular_user_is_exempt(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(get_settings(), "GUEST_MAX_STORAGE_BYTES", 80 * 1024 * 1024)
    guest = await _make_user(db_session, is_guest=True)
    regular = await _make_user(db_session, is_guest=False)
    sha = _sha()
    await _add_kb_file(db_session, guest, sha=sha, size=60 * 1024 * 1024)
    await db_session.commit()

    await GuestQuotaService.ensure_storage(db_session, guest, 10 * 1024 * 1024)
    with pytest.raises(BadRequestException):
        await GuestQuotaService.ensure_storage(db_session, guest, 30 * 1024 * 1024)

    # 正式账号不受匿名配额限制
    await GuestQuotaService.ensure_storage(db_session, regular, 10 * 1024 * 1024 * 1024)


@pytest.mark.asyncio
async def test_guest_skill_slot_limit(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(get_settings(), "GUEST_MAX_SKILLS", 1)
    guest = await _make_user(db_session, is_guest=True)
    db_session.add(AISkill(
        user_id=guest.id,
        code="mine_one",
        name="技能",
        prompt_template="p",
    ))
    await db_session.commit()

    with pytest.raises(ForbiddenException):
        await GuestQuotaService.ensure_skill_slot(db_session, guest)


@pytest.mark.asyncio
async def test_guest_daily_limit_is_capped_and_update_cannot_raise_it(
    db_session: AsyncSession,
):
    guest = await _make_user(db_session, is_guest=True)
    regular = await _make_user(db_session, is_guest=False)
    cap = get_settings().GUEST_KNOWLEDGE_DAILY_LIMIT

    settings = await KnowledgeSettingsService.effective(
        db_session, guest.id, is_guest=True,
    )
    assert settings.daily_limit == cap

    updated = await KnowledgeSettingsService.update(
        db_session, guest.id, daily_limit=999, is_guest=True,
    )
    assert updated.knowledge_daily_limit == cap
    effective = await KnowledgeSettingsService.effective(
        db_session, guest.id, is_guest=True,
    )
    assert effective.daily_limit == cap

    regular_updated = await KnowledgeSettingsService.update(
        db_session, regular.id, daily_limit=999, is_guest=False,
    )
    assert regular_updated.knowledge_daily_limit == 999


@pytest.mark.asyncio
async def test_dispatch_llm_passes_is_guest_to_router(monkeypatch: pytest.MonkeyPatch):
    from app.services.ai.llm_router import LLMRouter
    from app.services.note.recording.llm_dispatch import dispatch_llm

    captured: dict = {}

    async def fake_resolve(*args, **kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop before provider")

    monkeypatch.setattr(LLMRouter, "resolve", fake_resolve)
    with pytest.raises(RuntimeError):
        await dispatch_llm(
            None,
            system_prompt="s",
            user_prompt="u",
            user_id=uuid.uuid4(),
            is_guest=True,
        )
    assert captured.get("is_guest") is True
