"""知识库资产：登记、搜索、PDF 抽取容错、转笔记。"""
from __future__ import annotations

import uuid

import pytest

from app.exceptions import BadRequestException
from app.models.note.note import NoteFolder
from app.routers.note.note import _assert_folder_mutable
from app.services.note.kb_service import KbService


def test_system_folder_cannot_be_mutated():
    folder = NoteFolder(name="知识库", user_id=uuid.uuid4(), is_system=True)
    with pytest.raises(BadRequestException):
        _assert_folder_mutable(folder)

    folder.is_system = False
    _assert_folder_mutable(folder)


@pytest.mark.asyncio
async def test_ensure_knowledge_root_is_root_level_and_idempotent(db_session, test_user):
    root, folder = await KbService.ensure_knowledge_root(db_session, test_user.id)
    assert folder.parent_id is None
    assert folder.is_system is True
    assert root.folder_id == folder.id

    again_root, again_folder = await KbService.ensure_knowledge_root(db_session, test_user.id)
    assert again_root.id == root.id
    assert again_folder.id == folder.id


@pytest.mark.asyncio
async def test_knowledge_root_folder_is_protected_over_api(client, test_user):
    from app.auth import get_current_user
    from app.main import app

    app.dependency_overrides[get_current_user] = lambda: test_user
    try:
        created = await client.post("/api/v1/kb/roots/knowledge")
        assert created.status_code == 200
        body = created.json()
        assert body["folderName"] == "知识库"
        folder_id = body["folderId"]

        deleted = await client.delete(f"/api/v1/notes/folders/{folder_id}")
        assert deleted.status_code == 400

        moved = await client.patch(
            f"/api/v1/notes/folders/{folder_id}",
            json={"parent_id": str(uuid.uuid4())},
        )
        assert moved.status_code == 400
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.asyncio
async def test_invalid_pdf_extraction_returns_empty_text():
    from app.services.note.kb_service import _extract_document_text

    assert await _extract_document_text(b"not a pdf file", "bad.pdf", "application/pdf") == ""


def test_invalid_image_ocr_returns_empty_text():
    from app.services.note.kb_service import _extract_image_text

    assert _extract_image_text(b"not an image") == ""


@pytest.mark.asyncio
async def test_upload_search_and_convert_to_note(db_session, test_user):
    root = await KbService.ensure_root(db_session, test_user.id, name="个人知识库")
    record = await KbService.upload_file(
        db_session,
        test_user.id,
        root,
        path="raw/需求说明.txt",
        data="这是知识库资产的正文，包含检索关键词：交付验收".encode("utf-8"),
        mime="text/plain",
    )
    assert record.status == "indexed"

    hits = await KbService.list_files(db_session, test_user.id, query="需求说明")
    assert any(item.id == record.id for item in hits)

    text_hits = await KbService.list_files(db_session, test_user.id, query="交付验收")
    assert any(item.id == record.id for item in text_hits)

    note = await KbService.to_note(db_session, test_user.id, record)
    assert note.title == "需求说明"
    assert "来源" in str(note.content.get("text", ""))

    refreshed = await KbService.get_file(db_session, test_user.id, record.id)
    assert refreshed is not None
    assert refreshed.note_id == note.id
    assert refreshed.status == "converted"


@pytest.mark.asyncio
async def test_reupload_same_content_keeps_single_row(db_session, test_user):
    root = await KbService.ensure_root(db_session, test_user.id, name="去重测试")
    first = await KbService.upload_file(
        db_session, test_user.id, root, path="raw/a.txt", data=b"same", mime="text/plain",
    )
    second = await KbService.upload_file(
        db_session, test_user.id, root, path="raw/a.txt", data=b"same", mime="text/plain",
    )
    assert first.id == second.id
    files = await KbService.list_files(db_session, test_user.id)
    assert len([item for item in files if item.path == "raw/a.txt"]) == 1


@pytest.mark.asyncio
async def test_manifest_only_returns_changed_files(db_session, test_user):
    root = await KbService.ensure_root(db_session, test_user.id, name="增量测试")
    record = await KbService.upload_file(
        db_session, test_user.id, root, path="raw/a.txt", data=b"hello", mime="text/plain",
    )

    same = await KbService.sync_manifest(db_session, test_user.id, root, [
        {"path": "raw/a.txt", "hash": record.content_hash, "size": 5},
        {"path": "raw/new.txt", "hash": "newhash", "size": 3},
    ])
    assert same["unchanged"] == 1
    assert same["toUpload"] == ["raw/new.txt"]
    assert same["missing"] == []

    changed = await KbService.sync_manifest(db_session, test_user.id, root, [
        {"path": "raw/a.txt", "hash": "different", "size": 6},
    ])
    assert changed["toUpload"] == ["raw/a.txt"]
    # 清单里没有的文件标记为 missing，但不清空已抽取内容
    assert "raw/new.txt" not in changed["missing"]  # 之前只登记了 a.txt
    refreshed = await KbService.get_file(db_session, test_user.id, record.id)
    assert refreshed is not None and refreshed.content_hash == record.content_hash


@pytest.mark.asyncio
async def test_files_are_scoped_per_user(db_session, test_user):
    from app.models.user import User

    other = User(email="kb-other@test.com", password_hash="hash", name="Other")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    root = await KbService.ensure_root(db_session, test_user.id, name="私有库")
    await KbService.upload_file(
        db_session, test_user.id, root, path="raw/private.txt", data=b"secret", mime="text/plain",
    )
    other_files = await KbService.list_files(db_session, other.id)
    assert other_files == []
