"""Tests for AI note tools — type-specific preview and update paths."""
from __future__ import annotations

import uuid

import pytest

from app.ai_tools import note_tools as nt


@pytest.mark.asyncio
async def test_update_note_mindmap_preview(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "导图测试",
        "note_type": "mindmap",
        "content": {"data": {"text": "根"}, "children": []},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._update_note(
        db_session, test_user.id,
        note_id=str(note.id),
        content={"data": {"text": "新根"}, "children": [{"data": {"text": "子"}, "children": []}]},
    )
    assert result.get("requires_confirmation") is True
    assert result.get("note_type") == "mindmap"
    assert "新根" in result.get("preview_text", "")


@pytest.mark.asyncio
async def test_update_note_flowchart_preview(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "流程测试",
        "note_type": "flowchart",
        "content": {"xml": '<mxCell value="A"/>'},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._update_note(
        db_session, test_user.id,
        note_id=str(note.id),
        content={"xml": '<mxCell value="A"/><mxCell value="B"/>'},
    )
    assert result.get("requires_confirmation") is True
    assert "B" in result.get("preview_text", "")


@pytest.mark.asyncio
async def test_update_note_flowchart_rejects_text_tree(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "流程测试",
        "note_type": "flowchart",
        "content": {"xml": '<mxCell value="A"/>'},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._update_note(
        db_session, test_user.id,
        note_id=str(note.id),
        content={"xml": "AIDriveNote\n├── 笔记管理\n└── 内容管理"},
    )
    assert result.get("success") is False
    assert "mxGraphModel" in result.get("error", "") or "mxCell" in result.get("error", "")


@pytest.mark.asyncio
async def test_append_to_mindmap_preview(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "导图追加",
        "note_type": "mindmap",
        "content": {"data": {"text": "根", "uid": "root1"}, "children": []},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._append_to_mindmap(
        db_session, test_user.id,
        note_id=str(note.id),
        nodes={"data": {"text": "新节点"}, "children": []},
    )
    assert result.get("requires_confirmation") is True
    assert "新节点" in result.get("added_preview_text", "")


@pytest.mark.asyncio
async def test_append_to_mindmap_from_outline_string(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "导图大纲",
        "note_type": "mindmap",
        "content": {"data": {"text": "根", "uid": "root1"}, "children": []},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._append_to_mindmap(
        db_session, test_user.id,
        note_id=str(note.id),
        nodes="分支A\n├── 子1\n└── 子2\n分支B",
    )
    assert result.get("requires_confirmation") is True
    proposed = result.get("proposed_content") or {}
    assert len(proposed.get("children") or []) >= 2
    assert "子1" in result.get("added_preview_text", "")


@pytest.mark.asyncio
async def test_update_note_mindmap_from_multiline_single_node(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "导图修复",
        "note_type": "mindmap",
        "content": {"data": {"text": "旧根"}, "children": []},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._update_note(
        db_session, test_user.id,
        note_id=str(note.id),
        content={
            "data": {"text": "新主题\n├── 模块A\n└── 模块B"},
            "children": [],
        },
    )
    assert result.get("requires_confirmation") is True
    proposed = result.get("proposed_content") or {}
    assert len(proposed.get("children") or []) == 2


@pytest.mark.asyncio
async def test_get_note_summary_mode(db_session, test_user):
    from app.services.note.note_service import NoteService

    long_text = "x" * 3000
    note = await NoteService.create_note(db_session, {
        "title": "长文",
        "note_type": "markdown",
        "content": {"text": long_text},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    result = await nt._get_note(db_session, test_user.id, note_id=str(note.id))
    assert result["success"]
    assert result["note"].get("content") is None
    assert result["note"].get("content_summary")
    assert len(result["note"]["content_summary"]) <= 2001


@pytest.mark.asyncio
async def test_delete_note_requires_confirmation(db_session, test_user):
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "待删",
        "note_type": "markdown",
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    preview = await nt._delete_note(db_session, test_user.id, note_id=str(note.id))
    assert preview.get("requires_confirmation") is True
    assert preview.get("change_type") == "delete"

    still = await NoteService.get_note(db_session, note.id)
    assert still is not None

    deleted = await nt._delete_note(
        db_session, test_user.id, note_id=str(note.id), confirmed=True,
    )
    assert deleted.get("success") is True
