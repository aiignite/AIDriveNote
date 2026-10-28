"""网页剪藏服务测试。"""
from __future__ import annotations

import pytest

from app.services.note.clip_service import ClipService


@pytest.mark.asyncio
async def test_clip_creates_markdown_note_with_source(db_session, test_user):
    note, mode = await ClipService.create_clip(
        db_session,
        test_user.id,
        title="一段网页内容",
        text="这是选中的正文。",
        url="https://example.com/article",
    )
    assert mode == "new"
    assert note.title == "一段网页内容"
    text = str(note.content.get("text", ""))
    assert "这是选中的正文" in text
    assert "https://example.com/article" in text


@pytest.mark.asyncio
async def test_clip_falls_back_to_first_line_title(db_session, test_user):
    note, _mode = await ClipService.create_clip(
        db_session,
        test_user.id,
        text="第一行就是标题\n\n正文",
        url="https://example.com",
    )
    assert note.title == "第一行就是标题"


@pytest.mark.asyncio
async def test_clip_attaches_tags(db_session, test_user):
    from app.services.note.note_enhance_service import NoteTagService

    note, _mode = await ClipService.create_clip(
        db_session,
        test_user.id,
        text="带标签的剪藏",
        tags=["阅读", "阅读", "AI"],
    )
    tags = await NoteTagService.get_note_tags(db_session, note.id)
    assert {tag.name for tag in tags} == {"阅读", "AI"}


@pytest.mark.asyncio
async def test_clip_into_folder_by_name_creates_and_reuses(db_session, test_user):
    from app.services.note.note_service import NoteFolderService

    first, _mode = await ClipService.create_clip(
        db_session, test_user.id, text="第一封邮件摘要", folder_name="Mails",
    )
    second, _mode = await ClipService.create_clip(
        db_session, test_user.id, text="第二封邮件摘要", folder_name="Mails",
    )
    folders = await NoteFolderService.list_folders(db_session, test_user.id)
    mails = [folder for folder in folders if folder.name == "Mails"]
    assert len(mails) == 1
    assert first.folder_id == mails[0].id
    assert second.folder_id == mails[0].id


@pytest.mark.asyncio
async def test_clip_into_folder_by_id_rejects_other_users(db_session, test_user):
    from app.models.user import User
    from app.services.note.note_service import NoteFolderService

    other = User(email="clip-other@test.com", password_hash="hash", name="Other")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)
    folder = await NoteFolderService.create_folder(db_session, {
        "name": "别人的文件夹", "user_id": other.id, "parent_id": None,
    })
    with pytest.raises(ValueError):
        await ClipService.create_clip(
            db_session, test_user.id, text="越权", folder_id=folder.id,
        )


@pytest.mark.asyncio
async def test_append_mode_reuses_one_note(db_session, test_user):
    """日报追加模式：同一标题只保留一篇笔记，避免每天消耗配额。"""
    from app.services.note.note_service import NoteService

    first, mode1 = await ClipService.create_clip(
        db_session,
        test_user.id,
        title="Gemini 每日邮件摘要",
        text="第一天摘要",
        mode="append",
        note_title="Gemini 每日邮件摘要",
        folder_name="Mails",
    )
    second, mode2 = await ClipService.create_clip(
        db_session,
        test_user.id,
        text="第二天摘要",
        mode="append",
        note_title="Gemini 每日邮件摘要",
    )
    assert first.id == second.id
    assert mode1 == "new"
    assert mode2 == "append"

    refreshed = await NoteService.get_note(db_session, first.id)
    assert refreshed is not None
    text = str(refreshed.content.get("text", ""))
    assert "第一天摘要" in text
    assert "第二天摘要" in text
    # 仍然是同一篇笔记，且保留在 Mails 文件夹
    assert refreshed.folder_id == first.folder_id


@pytest.mark.asyncio
async def test_daily_mode_appends_to_daily_note(db_session, test_user):
    from app.services.note.daily_service import DailyNoteService

    first, mode1 = await ClipService.create_clip(
        db_session, test_user.id, text="日报内容 A", mode="daily",
    )
    second, mode2 = await ClipService.create_clip(
        db_session, test_user.id, text="日报内容 B", mode="daily",
    )
    assert first.id == second.id
    assert mode1 == mode2 == "daily"
    daily = await DailyNoteService.ensure_daily_note(db_session, test_user.id)
    assert daily.id == first.id


@pytest.mark.asyncio
async def test_empty_clip_is_rejected(db_session, test_user):
    with pytest.raises(ValueError):
        await ClipService.create_clip(db_session, test_user.id, text="  ")
