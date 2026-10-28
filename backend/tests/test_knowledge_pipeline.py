"""知识入库 → 解析 → 蒸馏 → 编译 的核心链路测试。"""
from __future__ import annotations

import io
import uuid
from pathlib import Path

import pytest
from sqlalchemy import func, select

from app.models.knowledge import IngestDocument, IngestJob, KnowledgeCard, NoteSource
from app.services.knowledge.ingest_service import ingest
from app.services.knowledge.ingest_worker import _distill_document, _parse_document
from app.services.knowledge.knowledge_compile_service import build_kb_target, compile_card
from app.services.knowledge.knowledge_extract_service import extract_cards, save_cards
from app.services.knowledge.parsing.base import ParseError
from app.services.knowledge.parsing.registry import parse_bytes, parse_text
from app.services.knowledge.rule_extractor import build_rule_card
from app.services.auth_service import AuthService


@pytest.mark.asyncio
async def test_ingest_is_idempotent_and_enqueues_parse(db_session, test_user):
    first, duplicate_first = await ingest(
        db_session,
        test_user.id,
        source_type="email",
        external_id="message-1",
        title="测试邮件",
        text="第一段内容。\n\n第二段内容。",
    )
    second, duplicate_second = await ingest(
        db_session,
        test_user.id,
        source_type="email",
        external_id="message-1",
        title="测试邮件",
        text="第一段内容。\n\n第二段内容。",
    )

    assert duplicate_first is False
    assert duplicate_second is True
    assert first.id == second.id

    doc_count = await db_session.scalar(select(func.count()).select_from(IngestDocument))
    job_count = await db_session.scalar(select(func.count()).select_from(IngestJob))
    assert doc_count == 1
    assert job_count == 1
    job = (await db_session.execute(select(IngestJob))).scalar_one()
    assert job.stage == "parse"
    assert job.status == "pending"


@pytest.mark.asyncio
async def test_ingest_bytes_saves_temp_file_for_parse(db_session, test_user):
    document, duplicate = await ingest(
        db_session,
        test_user.id,
        source_type="upload",
        external_id="upload-1",
        title="hello.txt",
        data=b"hello knowledge",
        mime="text/plain",
        raw_meta={"filename": "hello.txt"},
    )
    assert duplicate is False
    path = Path(str((document.raw_meta or {})["file_path"]))
    try:
        assert path.exists()
        assert path.read_bytes() == b"hello knowledge"
    finally:
        path.unlink(missing_ok=True)


def test_parse_text_and_html():
    plain = parse_text("第一段\n\n第二段", title="标题")
    assert plain.parser == "text"
    assert "第一段" in plain.text
    assert plain.meta["title"] == "标题"

    html = parse_text(
        "<html><head><title>文章标题</title></head>"
        "<body><h1>小标题</h1><p>这里是正文内容。</p></body></html>",
        mime="text/html",
    )
    assert html.parser == "html"
    assert "正文内容" in html.text


def test_parse_bytes_markdown_and_unknown_binary():
    parsed = parse_bytes("# 标题\n\n正文".encode("utf-8"), filename="a.md")
    assert parsed.parser == "text"
    assert "# 标题" in parsed.text

    with pytest.raises(ParseError):
        parse_bytes(b"\x00\x01\x02\x03\x04\x05", filename="a.bin")


def test_parse_pptx_extracts_slide_text():
    pytest.importorskip("pptx")
    from pptx import Presentation
    from pptx.util import Inches

    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[5])
    textbox = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(4), Inches(2))
    textbox.text_frame.text = "出风口执行器选型要点"
    buffer = io.BytesIO()
    presentation.save(buffer)

    parsed = parse_bytes(buffer.getvalue(), filename="选型.pptx")
    assert parsed.parser == "pptx"
    assert "Slide 1" in parsed.text
    assert "出风口执行器" in parsed.text


def _make_doc(db_session, test_user):
    return IngestDocument(
        user_id=test_user.id,
        source_type="email",
        external_id="rule-doc",
        content_hash="a" * 64,
        title="执行器选型讨论",
        raw_text=(
            "# 执行器选型讨论\n\n"
            "本次讨论聚焦出风口执行器的供应商与产能。\n\n"
            "## 结论\n\n"
            "- 优先选择博世作为主供应商\n"
            "- 需要提前锁定产能\n\n"
            "## 风险\n\n"
            "- 单一供应商存在交付风险\n"
        ),
        raw_meta={},
        parse_meta={},
        status="parsed",
    )


@pytest.mark.asyncio
async def test_rule_extractor_builds_actionable_card(db_session, test_user):
    doc = _make_doc(db_session, test_user)
    db_session.add(doc)
    await db_session.commit()

    card = build_rule_card(doc)
    assert card.title == "执行器选型讨论"
    assert "供应商" in card.summary
    assert card.payload["key_points"]
    assert card.payload["keywords"]
    assert card.confidence == "low"


@pytest.mark.asyncio
async def test_worker_parse_then_distill_creates_pending_card(db_session, test_user):
    document, _duplicate = await ingest(
        db_session,
        test_user.id,
        source_type="email",
        external_id="pipeline-1",
        title="执行器选型讨论",
        text=_make_doc(db_session, test_user).raw_text or "",
    )

    await _parse_document(db_session, document)
    await db_session.refresh(document)
    assert document.status == "parsed"
    assert document.parser == "text"
    assert "供应商" in (document.raw_text or "")

    await _distill_document(db_session, document)
    await db_session.refresh(document)
    assert document.status == "pending_review"
    cards = (
        await db_session.execute(
            select(KnowledgeCard).where(KnowledgeCard.document_id == document.id)
        )
    ).scalars().all()
    assert cards
    card = cards[0]
    assert card.status == "pending_review"
    assert card.extractor == "rule"
    assert "供应商" in card.summary


@pytest.mark.asyncio
async def test_email_digest_splits_into_multiple_cards(db_session, test_user):
    text = (
        "# 每日摘要\n\n"
        "## 条目一：供应商产能\n\n"
        "博世需要提前锁定产能。\n\n"
        "## 条目二：交付风险\n\n"
        "单一供应商存在交付风险。\n"
    )
    document, _duplicate = await ingest(
        db_session,
        test_user.id,
        source_type="email",
        external_id="digest-1",
        title="每日摘要",
        text=text,
    )
    drafts = await extract_cards(db_session, document, test_user.id)
    assert len(drafts) == 2
    assert drafts[0].title.startswith("每日摘要")
    cards = await save_cards(db_session, document, drafts)
    assert len(cards) == 2
    assert len({card.card_key for card in cards}) == 2


@pytest.mark.asyncio
async def test_compile_card_creates_note_with_source_and_tags(db_session, test_user):
    document, _duplicate = await ingest(
        db_session,
        test_user.id,
        source_type="email",
        external_id="compile-1",
        title="执行器选型讨论",
        text=_make_doc(db_session, test_user).raw_text or "",
    )
    drafts = await extract_cards(db_session, document, test_user.id)
    cards = await save_cards(db_session, document, drafts)
    card = cards[0]

    note, kb_target = await compile_card(db_session, test_user.id, card.id, mode="new")
    assert note.title == card.title
    assert "摘要" in str(note.content.get("text", ""))
    assert "[kb]" in (note.description or "")
    assert kb_target["wikiPath"].startswith("wiki/")
    assert kb_target["rawPath"].startswith("raw/")

    await db_session.refresh(card)
    await db_session.refresh(document)
    assert card.status == "approved"
    assert card.note_id == note.id
    assert document.status == "approved"

    source = (
        await db_session.execute(select(NoteSource).where(NoteSource.note_id == note.id))
    ).scalar_one()
    assert source.document_id == document.id
    assert source.role == "primary"


def test_build_kb_target_uses_expected_dirs():
    doc = IngestDocument(
        source_type="clip",
        external_id="x",
        content_hash="b" * 64,
        title="网页文章",
        raw_meta={},
    )
    card = KnowledgeCard(
        knowledge_type="concept",
        title="出风口执行器",
        summary="一句话摘要",
        confidence="high",
        payload={"topic": "产品开发", "tags": ["执行器"]},
    )
    target = build_kb_target(card, doc)
    assert target["wikiPath"].startswith("wiki/concepts/")
    assert target["rawPath"].startswith("raw/web/")
    assert target["frontmatter"]["type"] == "concept"
    assert target["frontmatter"]["sources"] == [target["rawPath"]]


@pytest.mark.asyncio
async def test_ingest_inbox_approve_api(client, db_session, test_user):
    access_token, _ = AuthService.create_access_token(test_user.id)
    headers = {"Authorization": f"Bearer {access_token}"}

    created = await client.post(
        "/api/v1/ingest/documents",
        json={
            "sourceType": "email",
            "externalId": "api-mail-1",
            "title": "执行器选型讨论",
            "text": (
                "# 执行器选型讨论\n\n"
                "本次讨论聚焦出风口执行器的供应商与产能。\n\n"
                "## 结论\n\n"
                "- 优先选择博世作为主供应商\n"
                "- 需要提前锁定产能\n"
            ),
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    document_id = created.json()["documentId"]

    document = await db_session.get(IngestDocument, uuid.UUID(document_id))
    assert document is not None
    await _parse_document(db_session, document)
    await _distill_document(db_session, document)

    inbox = await client.get(
        "/api/v1/knowledge/inbox?status=pending_review", headers=headers,
    )
    assert inbox.status_code == 200, inbox.text
    items = inbox.json()["items"]
    assert len(items) == 1
    card = items[0]
    assert card["title"] == "执行器选型讨论"
    assert card["source"]["type"] == "email"

    approved = await client.post(
        f"/api/v1/knowledge/cards/{card['id']}/approve",
        json={"mode": "new"},
        headers=headers,
    )
    assert approved.status_code == 200, approved.text
    note_id = approved.json()["noteId"]

    note = await client.get(f"/api/v1/notes/{note_id}", headers=headers)
    assert note.status_code == 200, note.text
    body = note.json()
    assert body["title"] == "执行器选型讨论"
    assert "摘要" in str(body.get("content", {}).get("text", ""))

    search = await client.get(
        "/api/v1/notes/search/fulltext?q=执行器", headers=headers,
    )
    assert search.status_code == 200, search.text
    payload = search.json()
    assert payload["knowledge"][note_id]["source_type"] == "email"
    assert payload["knowledge"][note_id]["summary"]

    entity = await client.post(
        f"/api/v1/knowledge/cards/{card['id']}/entity-page",
        json={"name": "博世", "entityType": "entity"},
        headers=headers,
    )
    assert entity.status_code == 200, entity.text
    assert entity.json()["created"] is True
    again = await client.post(
        f"/api/v1/knowledge/cards/{card['id']}/entity-page",
        json={"name": "博世", "entityType": "entity"},
        headers=headers,
    )
    assert again.status_code == 200
    assert again.json()["created"] is False

    lint = await client.get("/api/v1/knowledge/lint", headers=headers)
    assert lint.status_code == 200, lint.text
    assert lint.json()["checked"] >= 2


@pytest.mark.asyncio
async def test_knowledge_settings_api(client, test_user):
    access_token, _ = AuthService.create_access_token(test_user.id)
    headers = {"Authorization": f"Bearer {access_token}"}

    current = await client.get("/api/v1/knowledge/settings", headers=headers)
    assert current.status_code == 200, current.text
    data = current.json()
    assert "distillEnabled" in data
    assert data["dailyLimit"] >= 0

    patched = await client.patch(
        "/api/v1/knowledge/settings",
        json={"allowExternal": True, "dailyLimit": 7},
        headers=headers,
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["allowExternal"] is True
    assert patched.json()["dailyLimit"] == 7
