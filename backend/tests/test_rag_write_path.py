"""P0 RAG 写入链路 / 检索覆盖 / 引用契约的回归测试。"""
from __future__ import annotations

import pytest

from app.services.note.link_parser import build_search_text
from app.services.note.note_enhance_service import NoteSearchService, highlight_snippet
from app.services.note.note_service import NoteService


def test_flowchart_text_enters_search_index():
    content = {
        "xml": (
            '<mxGraphModel><root><mxCell id="0"/>'
            '<mxCell id="2" value="提交申请" vertex="1"/>'
            '<mxCell id="3" value="审批通过" vertex="1"/>'
            "</root></mxGraphModel>"
        ),
    }
    text = build_search_text("报销流程", None, content, "flowchart")
    assert "提交申请" in text
    assert "审批通过" in text


def test_highlight_snippet_marks_query_and_escapes_html():
    snippet = highlight_snippet("<script>alert(1)</script> 这里讲 RAG 检索", "RAG")
    assert "<script>" not in snippet
    assert "<mark>RAG</mark>" in snippet


def test_highlight_snippet_returns_escaped_preview_when_no_match():
    snippet = highlight_snippet("<b>无命中</b>", "不存在")
    assert snippet == "&lt;b&gt;无命中&lt;/b&gt;"


@pytest.mark.asyncio
async def test_create_note_schedules_embedding(db_session, test_user, monkeypatch):
    import app.services.ai.embedding_service as embedding_service

    scheduled: list = []
    monkeypatch.setattr(
        embedding_service,
        "schedule_note_embedding",
        lambda note_id: scheduled.append(note_id) or True,
    )

    note = await NoteService.create_note(db_session, {
        "title": "新建即入索引",
        "note_type": "markdown",
        "content": {"text": "正文里有关键词 检索地基"},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })

    assert scheduled == [note.id]


@pytest.mark.asyncio
async def test_full_text_search_can_include_shared_notes(db_session, test_user):
    from app.models.note.note import NoteShare
    from app.models.user import User

    other = User(email="other@test.com", password_hash="hash", name="Owner")
    db_session.add(other)
    await db_session.commit()
    await db_session.refresh(other)

    note = await NoteService.create_note(db_session, {
        "title": "别人的笔记",
        "note_type": "markdown",
        "content": {"text": "共享关键词 只在被分享后可见"},
        "created_by": other.id,
        "updated_by": other.id,
    })

    own_only, _ = await NoteSearchService.full_text_search(
        db_session, user_id=test_user.id, query="共享关键词",
    )
    assert all(n.id != note.id for n in own_only)

    db_session.add(NoteShare(
        note_id=note.id,
        shared_with_user_id=test_user.id,
        permission="view",
        created_by=other.id,
    ))
    await db_session.commit()

    shared, _ = await NoteSearchService.full_text_search(
        db_session, user_id=test_user.id, query="共享关键词", include_shared=True,
    )
    assert any(n.id == note.id for n in shared)


@pytest.mark.asyncio
async def test_rag_context_returns_structured_citations(db_session, test_user, monkeypatch):
    from app.services.ai.embedding_service import EmbeddingService
    from app.services.ai.rag_service import RagService

    note = await NoteService.create_note(db_session, {
        "title": "引用来源",
        "note_type": "markdown",
        "content": {"text": "这是一段会被引用的正文"},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })

    async def fake_full_text(db, **kwargs):
        return [note], 1

    async def fake_semantic(db, user_id, query, *, limit=5, **kwargs):
        return []

    monkeypatch.setattr(NoteSearchService, "full_text_search", staticmethod(fake_full_text))
    monkeypatch.setattr(EmbeddingService, "semantic_search", staticmethod(fake_semantic))

    context, citations = await RagService.build_context_with_citations(
        db_session, test_user.id, "会被引用吗",
    )

    assert "引用来源" in context
    assert len(citations) == 1
    citation = citations[0]
    assert citation["noteId"] == str(note.id)
    assert citation["title"] == "引用来源"
    assert citation["source"] == "retrieval"
    assert citation["quote"]


@pytest.mark.asyncio
async def test_long_question_falls_back_to_prefix_match(db_session, test_user):
    """长自然语言问句在 trigram 下会整体失配，应退化到标题前缀召回。"""
    target = await NoteService.create_note(db_session, {
        "title": "发布检查清单",
        "note_type": "markdown",
        "content": {"text": "上线前检查证书、监控与回滚脚本。"},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    await NoteService.create_note(db_session, {
        "title": "午餐菜单",
        "note_type": "markdown",
        "content": {"text": "本周午餐安排。"},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })

    items, total = await NoteSearchService.full_text_search(
        db_session, user_id=test_user.id, query="发布检查清单包含哪些检查项？",
    )
    assert total >= 1
    assert any(note.id == target.id for note in items)


@pytest.mark.asyncio
async def test_rag_v1_fallback_includes_shared_notes(db_session, test_user, monkeypatch):
    """v2 不可用时，v1 回退路径也必须把共享笔记纳入检索。"""
    from app.services.ai.embedding_service import EmbeddingService
    from app.services.ai.rag_service import RagService

    captured: dict = {}

    async def fake_full_text(db, **kwargs):
        captured["fts"] = kwargs
        return [], 0

    async def fake_semantic(db, user_id, query, **kwargs):
        captured["semantic"] = kwargs
        return []

    monkeypatch.setattr(NoteSearchService, "full_text_search", staticmethod(fake_full_text))
    monkeypatch.setattr(EmbeddingService, "semantic_search", staticmethod(fake_semantic))

    await RagService.build_context_with_citations(db_session, test_user.id, "共享吗")

    assert captured["fts"]["include_shared"] is True
    assert captured["semantic"]["include_shared"] is True


@pytest.mark.asyncio
async def test_encrypted_note_is_never_embedded(db_session, test_user):
    from app.services.ai.embedding_service import EmbeddingService

    note = await NoteService.create_note(db_session, {
        "title": "加密笔记",
        "note_type": "markdown",
        "content": {"text": "明文不该进入向量"},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    note.is_encrypted = True

    succeeded = await EmbeddingService.update_note_embedding(db_session, note)
    assert succeeded is False
    assert note.content_embedding is None
