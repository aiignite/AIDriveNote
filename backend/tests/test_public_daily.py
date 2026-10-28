"""公开只读链接与每日笔记的回归测试。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models.note.note import NotePublicLink
from app.services.note.daily_service import DailyNoteService
from app.services.note.note_service import NoteService
from app.services.note.public_link_service import NotePublicLinkService


async def _make_note(db, user, title="公开分享笔记"):
    return await NoteService.create_note(db, {
        "title": title,
        "note_type": "markdown",
        "content": {"text": "这是一篇准备公开的笔记"},
        "created_by": user.id,
        "updated_by": user.id,
    })


@pytest.mark.asyncio
async def test_public_link_create_resolve_revoke(db_session, test_user):
    note = await _make_note(db_session, test_user)
    link = await NotePublicLinkService.create_or_get(db_session, note, test_user.id)
    assert link.token

    resolved = await NotePublicLinkService.resolve(db_session, link.token)
    assert resolved is not None and resolved.id == note.id

    # 重复创建复用同一个 token
    again = await NotePublicLinkService.create_or_get(db_session, note, test_user.id)
    assert again.token == link.token

    removed = await NotePublicLinkService.revoke(db_session, note.id)
    assert removed == 1
    assert await NotePublicLinkService.resolve(db_session, link.token) is None


@pytest.mark.asyncio
async def test_expired_public_link_is_rejected(db_session, test_user):
    note = await _make_note(db_session, test_user)
    link = await NotePublicLinkService.create_or_get(db_session, note, test_user.id)
    link.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    assert await NotePublicLinkService.resolve(db_session, link.token) is None
    assert await NotePublicLinkService.get_active(db_session, note.id) is None


@pytest.mark.asyncio
async def test_public_link_rejects_deleted_note(db_session, test_user):
    note = await _make_note(db_session, test_user)
    link = await NotePublicLinkService.create_or_get(db_session, note, test_user.id)
    note.is_deleted = True
    await db_session.commit()
    assert await NotePublicLinkService.resolve(db_session, link.token) is None


@pytest.mark.asyncio
async def test_daily_note_is_idempotent(db_session, test_user):
    first = await DailyNoteService.ensure_daily_note(db_session, test_user.id, "2026-01-02")
    second = await DailyNoteService.ensure_daily_note(db_session, test_user.id, "2026-01-02")
    assert first.id == second.id
    assert first.title == "2026-01-02"
    assert "今日要事" in str(first.content.get("text", ""))


@pytest.mark.asyncio
async def test_daily_review_falls_back_without_llm(db_session, test_user):
    await _make_note(db_session, test_user, title="昨天的推进")
    result = await DailyNoteService.build_review(db_session, test_user.id, "2026-01-03")
    assert result["noteCount"] >= 1
    assert "2026-01-03" in result["markdown"]
    assert "昨天的推进" in result["markdown"]
