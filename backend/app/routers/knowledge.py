"""知识收件箱与审核接口。"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_not_guest, require_write_scope
from app.database import get_db
from app.exceptions import BadRequestException, NotFoundException
from app.models.knowledge import IngestDocument, KnowledgeCard
from app.models.note.note import Note, NoteLink, NoteNoteTag, NoteTag
from app.models.user import User
from app.schemas.camel import CamelRequest
from app.services.knowledge.ingest_service import enqueue_ingest_job, hash_text, ingest
from app.services.knowledge.knowledge_compile_service import compile_card
from app.services.knowledge.settings_service import KnowledgeSettingsService
from app.services.note.link_parser import build_search_text, extract_wiki_links
from app.services.note.note_enhance_service import NoteTagService
from app.services.note.note_service import NoteService

router = APIRouter(prefix="/knowledge", tags=["Knowledge"])
note_router = APIRouter(tags=["KnowledgeIngest"])


class ApproveRequest(CamelRequest):
    mode: Literal["new", "merge"] = "new"
    note_id: Optional[UUID] = None
    folder_id: Optional[UUID] = None
    title: Optional[str] = None
    tags: Optional[list[str]] = None


class IgnoreRequest(BaseModel):
    reason: Optional[str] = None


class BatchRequest(CamelRequest):
    card_ids: list[UUID] = Field(default_factory=list)
    action: Literal["approve", "ignore"] = "approve"


class KbStatusRequest(BaseModel):
    status: str
    path: Optional[str] = None


class KnowledgeSettingsUpdate(CamelRequest):
    distill_enabled: Optional[bool] = None
    allow_external: Optional[bool] = None
    daily_limit: Optional[int] = None
    model: Optional[str] = None


class EntityPageRequest(CamelRequest):
    name: str
    entity_type: str = "concept"
    topic: Optional[str] = None


def _source_payload(doc: IngestDocument) -> dict:
    return {
        "documentId": str(doc.id),
        "type": doc.source_type,
        "title": doc.title,
        "url": doc.url,
        "occurredAt": doc.occurred_at.isoformat() if doc.occurred_at else None,
        "status": doc.status,
        "parser": doc.parser,
        "parseMeta": doc.parse_meta or {},
        "error": doc.error,
    }


def _card_payload(
    card: KnowledgeCard,
    doc: IngestDocument,
    *,
    merge_target_title: str | None = None,
) -> dict:
    payload = card.payload or {}
    return {
        "id": str(card.id),
        "documentId": str(card.document_id),
        "status": card.status,
        "knowledgeType": card.knowledge_type,
        "title": card.title,
        "summary": card.summary,
        "confidence": card.confidence,
        "keyPoints": payload.get("key_points") or [],
        "keywords": payload.get("keywords") or [],
        "entities": payload.get("entities") or [],
        "claims": payload.get("claims") or [],
        "topic": payload.get("topic") or "",
        "tags": payload.get("tags") or [],
        "needsReview": bool(payload.get("needs_review")),
        "mergeTarget": (
            {
                "noteId": str(card.merge_target_note_id),
                "title": merge_target_title,
                "score": card.merge_score,
            }
            if card.merge_target_note_id
            else None
        ),
        "noteId": str(card.note_id) if card.note_id else None,
        "kbTarget": card.kb_target or {},
        "extractor": card.extractor,
        "model": card.model,
        "createdAt": card.created_at.isoformat() if card.created_at else None,
        "source": _source_payload(doc),
    }


async def _get_card(
    db: AsyncSession, user_id: UUID, card_id: UUID,
) -> tuple[KnowledgeCard, IngestDocument]:
    result = await db.execute(
        select(KnowledgeCard).where(
            KnowledgeCard.id == card_id,
            KnowledgeCard.user_id == user_id,
        )
    )
    card = result.scalar_one_or_none()
    if card is None:
        raise NotFoundException("knowledge card", str(card_id))
    doc = await db.get(IngestDocument, card.document_id)
    if doc is None:
        raise NotFoundException("ingest document", str(card.document_id))
    return card, doc


@router.get("/inbox")
async def list_inbox(
    status: str = Query("pending_review"),
    source_type: Optional[str] = Query(None, alias="sourceType"),
    cursor: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    stmt = (
        select(KnowledgeCard, IngestDocument)
        .join(IngestDocument, IngestDocument.id == KnowledgeCard.document_id)
        .where(KnowledgeCard.user_id == user.id)
        .order_by(KnowledgeCard.created_at.desc())
        .limit(limit + 1)
    )
    if status and status != "all":
        stmt = stmt.where(KnowledgeCard.status == status)
    if source_type:
        stmt = stmt.where(IngestDocument.source_type == source_type)
    if cursor:
        try:
            cursor_dt = datetime.fromisoformat(cursor)
            if cursor_dt.tzinfo is None:
                cursor_dt = cursor_dt.replace(tzinfo=timezone.utc)
            stmt = stmt.where(KnowledgeCard.created_at < cursor_dt)
        except ValueError:
            pass

    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]

    merge_ids = [card.merge_target_note_id for card, _doc in rows if card.merge_target_note_id]
    titles: dict[str, str] = {}
    if merge_ids:
        note_rows = await db.execute(select(Note.id, Note.title).where(Note.id.in_(merge_ids)))
        titles = {str(note_id): title for note_id, title in note_rows.all()}

    items = [
        _card_payload(card, doc, merge_target_title=titles.get(str(card.merge_target_note_id)))
        for card, doc in rows
    ]
    next_cursor = None
    if has_more and rows:
        last = rows[-1][0]
        next_cursor = last.created_at.isoformat() if last.created_at else None
    return {"items": items, "nextCursor": next_cursor}


@router.get("/cards/{card_id}")
async def get_card(
    card_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    card, doc = await _get_card(db, user.id, card_id)
    merge_title = None
    if card.merge_target_note_id:
        note = await NoteService.get_note(db, card.merge_target_note_id)
        merge_title = note.title if note else None
    payload = _card_payload(card, doc, merge_target_title=merge_title)
    payload["rawText"] = (doc.raw_text or "")[:20_000]
    payload["rawMeta"] = doc.raw_meta or {}
    payload["decidedAt"] = card.decided_at.isoformat() if card.decided_at else None
    return payload


@router.get("/cards/{card_id}/source")
async def get_card_source(
    card_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    """返回知识卡对应的完整源文本，供本地知识库写回使用。"""
    _card, doc = await _get_card(db, user.id, card_id)
    return {
        "rawText": doc.raw_text or "",
        "rawMeta": doc.raw_meta or {},
        "source": _source_payload(doc),
    }


@router.post("/cards/{card_id}/approve")
async def approve_card(
    card_id: UUID,
    body: ApproveRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    try:
        note, kb_target = await compile_card(
            db,
            user.id,
            card_id,
            mode=body.mode,
            note_id=body.note_id,
            folder_id=body.folder_id,
            title=body.title,
            tags=body.tags,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    return {
        "noteId": str(note.id),
        "title": note.title,
        "kbTarget": kb_target,
    }


@router.post("/cards/{card_id}/ignore")
async def ignore_card(
    card_id: UUID,
    body: IgnoreRequest | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    card, doc = await _get_card(db, user.id, card_id)
    card.status = "ignored"
    card.decided_by = user.id
    card.decided_at = datetime.now(timezone.utc)
    if body and body.reason:
        payload = dict(card.payload or {})
        payload["ignore_reason"] = body.reason[:500]
        card.payload = payload
    doc.reviewed_at = card.decided_at
    remaining = await db.execute(
        select(func.count()).select_from(KnowledgeCard).where(
            KnowledgeCard.document_id == doc.id,
            KnowledgeCard.status.in_(["pending_review", "approved", "merged"]),
        )
    )
    if int(remaining.scalar() or 0) == 0:
        doc.status = "ignored"
    await db.commit()
    return {"id": str(card.id), "status": card.status}


@router.post("/cards/{card_id}/retry")
async def retry_card(
    card_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    card, doc = await _get_card(db, user.id, card_id)
    await db.execute(
        update(KnowledgeCard)
        .where(
            KnowledgeCard.document_id == doc.id,
            KnowledgeCard.status == "pending_review",
        )
        .values(status="ignored")
    )
    doc.status = "parsed"
    doc.error = None
    await enqueue_ingest_job(db, doc.id, "distill")
    await db.commit()
    return {"documentId": str(doc.id), "status": doc.status}


@router.post("/cards/batch")
async def batch_cards(
    body: BatchRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    results: list[dict] = []
    for card_id in body.card_ids[:50]:
        try:
            if body.action == "approve":
                note, _kb = await compile_card(db, user.id, card_id, mode="new")
                results.append({"cardId": str(card_id), "ok": True, "noteId": str(note.id)})
            else:
                card, doc = await _get_card(db, user.id, card_id)
                card.status = "ignored"
                card.decided_by = user.id
                card.decided_at = datetime.now(timezone.utc)
                remaining = await db.execute(
                    select(func.count()).select_from(KnowledgeCard).where(
                        KnowledgeCard.document_id == doc.id,
                        KnowledgeCard.status.in_(["pending_review", "approved", "merged"]),
                    )
                )
                if int(remaining.scalar() or 0) == 0:
                    doc.status = "ignored"
                await db.commit()
                results.append({"cardId": str(card_id), "ok": True})
        except Exception as exc:  # noqa: BLE001 — 批量操作逐条返回结果
            await db.rollback()
            results.append({"cardId": str(card_id), "ok": False, "error": str(exc)[:300]})
    return {"results": results}


@router.patch("/cards/{card_id}/kb-status")
async def update_kb_status(
    card_id: UUID,
    body: KbStatusRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    card, _doc = await _get_card(db, user.id, card_id)
    kb_target = dict(card.kb_target or {})
    kb_target["status"] = body.status
    if body.path:
        kb_target["path"] = body.path
    card.kb_target = kb_target
    await db.commit()
    return {"id": str(card.id), "kbTarget": kb_target}


async def _knowledge_settings_payload(db: AsyncSession, user_id: UUID) -> dict:
    prefs = await KnowledgeSettingsService.effective(db, user_id)
    from app.services.ai.ownership import resolve_default_model

    default_model = await resolve_default_model(db, user_id)
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    used_today = await db.scalar(
        select(func.count()).select_from(KnowledgeCard).where(
            KnowledgeCard.user_id == user_id,
            KnowledgeCard.extractor == "llm",
            KnowledgeCard.created_at >= today,
        )
    )
    total_row = await db.execute(
        select(
            func.coalesce(func.sum(KnowledgeCard.input_tokens), 0),
            func.coalesce(func.sum(KnowledgeCard.output_tokens), 0),
        ).where(
            KnowledgeCard.user_id == user_id,
            KnowledgeCard.extractor == "llm",
        )
    )
    today_row = await db.execute(
        select(
            func.coalesce(func.sum(KnowledgeCard.input_tokens), 0),
            func.coalesce(func.sum(KnowledgeCard.output_tokens), 0),
        ).where(
            KnowledgeCard.user_id == user_id,
            KnowledgeCard.extractor == "llm",
            KnowledgeCard.created_at >= today,
        )
    )
    total_in, total_out = total_row.one()
    today_in, today_out = today_row.one()
    return {
        "distillEnabled": prefs.distill_enabled,
        "allowExternal": prefs.allow_external,
        "dailyLimit": prefs.daily_limit,
        "model": prefs.model or None,
        "defaultModel": default_model.name if default_model else None,
        "configured": prefs.configured,
        "usedToday": int(used_today or 0),
        "tokensToday": int(today_in or 0) + int(today_out or 0),
        "tokensTotal": int(total_in or 0) + int(total_out or 0),
    }


@router.post("/documents/{document_id}/reindex")
async def reindex_document(
    document_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    """按来源文档重建其知识笔记的 RAG 索引。"""
    document = await get_document(db, user.id, document_id)
    if document is None or document.note_id is None:
        raise NotFoundException("knowledge note", str(document_id))
    note = await NoteService.get_note(db, document.note_id)
    if note is None:
        raise NotFoundException("note", str(document.note_id))
    from app.services.ai.rag_index_service import enqueue_note_index

    queued = await enqueue_note_index(
        db, note.id, user.id, reason="knowledge_source",
    )
    if queued:
        return {"noteId": str(note.id), "queued": True, "mode": "v2"}

    # 生产未安装 pgvector 时 RAG v2 会降级；这里回退到 v1 整篇向量，
    # 避免「重建索引」按钮在降级环境直接报错。
    from app.services.ai.embedding_service import EmbeddingService

    updated = await EmbeddingService.update_note_embedding(db, note)
    await db.commit()
    if not updated:
        raise BadRequestException("RAG v2 未启用且嵌入服务不可用，无法重建索引")
    return {"noteId": str(note.id), "queued": False, "mode": "v1"}


@router.post("/cards/{card_id}/entity-page")
async def create_entity_page(
    card_id: UUID,
    body: EntityPageRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    """从知识卡中提到的实体/主题创建一页 wiki 知识页（幂等按标题）。"""
    card, doc = await _get_card(db, user.id, card_id)
    name = (body.name or "").strip()[:200]
    if not name:
        raise BadRequestException("实体名不能为空")

    existing = await db.execute(
        select(Note).where(
            Note.created_by == user.id,
            func.lower(Note.title) == name.lower(),
            Note.is_deleted == False,  # noqa: E712
        )
    )
    existing_note = existing.scalar_one_or_none()
    if existing_note is not None:
        return {"noteId": str(existing_note.id), "title": existing_note.title, "created": False}

    kb_type = "topic" if body.entity_type == "topic" else "entity"
    raw_path = (card.kb_target or {}).get("rawPath") or f"raw/notes/{doc.title or card.title}.md"
    description = (
        f"由知识卡《{card.title}》沉淀的{kb_type}页。\n"
        f"[kb] confidence: medium | sources: [{raw_path}]"
    )[:1000]
    content = (
        f"# {name}\n\n"
        f"> 由知识卡《{card.title}》沉淀的{('主题' if kb_type == 'topic' else '实体')}页。\n\n"
        f"## 相关\n- [[{card.title}]]\n\n"
        f"## 来源\n- {doc.url or doc.title or card.title}\n"
    )
    note = await NoteService.create_note(
        db,
        {
            "title": name,
            "note_type": "markdown",
            "content": {"text": content},
            "description": description,
            "created_by": user.id,
            "updated_by": user.id,
        },
    )
    tag_names = [f"kb:{kb_type}"]
    if body.topic:
        tag_names.append(f"topic:{body.topic}"[:40])
    existing_tags = {tag.name.lower(): tag for tag in await NoteTagService.list_tags(db, user.id)}
    for tag_name in tag_names:
        tag = existing_tags.get(tag_name.lower())
        if tag is None:
            tag = await NoteTagService.create_tag(db, user.id, tag_name)
            existing_tags[tag_name.lower()] = tag
        await NoteTagService.add_tag_to_note(db, note.id, tag.id, user.id)
    return {"noteId": str(note.id), "title": note.title, "created": True}


@router.get("/lint")
async def knowledge_lint(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    """知识库体检：无来源、重复标题、断链、孤儿页。"""
    kb_tag_ids = (
        await db.execute(
            select(NoteTag.id).where(
                NoteTag.user_id == user.id,
                NoteTag.name.like("kb:%"),
            )
        )
    ).scalars().all()
    if not kb_tag_ids:
        return {
            "checked": 0,
            "missingSource": [],
            "duplicates": [],
            "brokenLinks": [],
            "orphans": [],
            "counts": {"missingSource": 0, "duplicates": 0, "brokenLinks": 0, "orphans": 0},
        }

    note_ids = (
        await db.execute(
            select(NoteNoteTag.note_id).where(NoteNoteTag.tag_id.in_(kb_tag_ids))
        )
    ).scalars().all()
    notes = (
        await db.execute(
            select(Note).where(
                Note.id.in_(note_ids),
                Note.created_by == user.id,
                Note.is_deleted == False,  # noqa: E712
            )
        )
    ).scalars().all()

    all_notes = (
        await db.execute(
            select(Note.id, Note.title).where(
                Note.created_by == user.id,
                Note.is_deleted == False,  # noqa: E712
            )
        )
    ).all()
    normalize = lambda value: (value or "").strip().lower()  # noqa: E731
    title_set = {normalize(title) for _id, title in all_notes}
    inbound = {
        str(target_id)
        for target_id in (
            await db.execute(
                select(NoteLink.target_id).where(NoteLink.source_id.in_(note_ids))
            )
        ).scalars().all()
    }

    missing_source: list[dict] = []
    broken_links: list[dict] = []
    orphans: list[dict] = []
    title_map: dict[str, list[str]] = {}
    for note in notes:
        if "sources:" not in (note.description or ""):
            missing_source.append({"noteId": str(note.id), "title": note.title})
        links = extract_wiki_links(note.content, note.note_type)
        bad = [link for link in links if normalize(link) not in title_set]
        if bad:
            broken_links.append({"noteId": str(note.id), "title": note.title, "links": bad[:10]})
        if not links and str(note.id) not in inbound:
            orphans.append({"noteId": str(note.id), "title": note.title})
        title_map.setdefault(normalize(note.title), []).append(str(note.id))

    duplicates = [
        {"title": title, "noteIds": ids}
        for title, ids in title_map.items()
        if len(ids) > 1
    ]
    return {
        "checked": len(notes),
        "missingSource": missing_source[:50],
        "duplicates": duplicates[:20],
        "brokenLinks": broken_links[:50],
        "orphans": orphans[:50],
        "counts": {
            "missingSource": len(missing_source),
            "duplicates": len(duplicates),
            "brokenLinks": len(broken_links),
            "orphans": len(orphans),
        },
    }


@router.get("/settings")
async def get_knowledge_settings(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    return await _knowledge_settings_payload(db, user.id)


@router.patch("/settings")
async def update_knowledge_settings(
    body: KnowledgeSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    await KnowledgeSettingsService.update(
        db,
        user.id,
        distill_enabled=body.distill_enabled,
        allow_external=body.allow_external,
        daily_limit=body.daily_limit,
        model=body.model,
    )
    return await _knowledge_settings_payload(db, user.id)


@router.get("/stats")
async def knowledge_stats(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    rows = await db.execute(
        select(KnowledgeCard.status, func.count())
        .where(KnowledgeCard.user_id == user.id)
        .group_by(KnowledgeCard.status)
    )
    counts = {status: int(count) for status, count in rows.all()}
    token_row = await db.execute(
        select(
            func.coalesce(func.sum(KnowledgeCard.input_tokens), 0),
            func.coalesce(func.sum(KnowledgeCard.output_tokens), 0),
            func.count(),
        ).where(
            KnowledgeCard.user_id == user.id,
            KnowledgeCard.extractor == "llm",
        )
    )
    total_in, total_out, llm_cards = token_row.one()
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_row = await db.execute(
        select(
            func.coalesce(func.sum(KnowledgeCard.input_tokens), 0),
            func.coalesce(func.sum(KnowledgeCard.output_tokens), 0),
        ).where(
            KnowledgeCard.user_id == user.id,
            KnowledgeCard.extractor == "llm",
            KnowledgeCard.created_at >= today,
        )
    )
    today_in, today_out = today_row.one()
    return {
        "pendingReview": counts.get("pending_review", 0),
        "approved": counts.get("approved", 0),
        "merged": counts.get("merged", 0),
        "ignored": counts.get("ignored", 0),
        "failed": counts.get("failed", 0),
        "total": sum(counts.values()),
        "llmCards": int(llm_cards or 0),
        "tokensTotal": int(total_in or 0) + int(total_out or 0),
        "tokensToday": int(today_in or 0) + int(today_out or 0),
    }


@note_router.post("/notes/{note_id}/distill")
async def distill_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    """把一篇自写笔记送入同一蒸馏管线。"""
    note = await NoteService.get_note(db, note_id)
    if note is None:
        raise NotFoundException("note", str(note_id))
    if note.created_by != user.id:
        raise BadRequestException("无权操作该笔记")
    if note.is_encrypted:
        raise BadRequestException("加密笔记不支持知识抽取")
    if note.note_type == "document":
        text = (note.search_text or "").strip()
    else:
        text = build_search_text(note.title, note.description, note.content, note.note_type)
    if not (text or "").strip():
        raise BadRequestException("笔记内容为空")
    document, duplicate = await ingest(
        db,
        user.id,
        source_type="note",
        external_id=f"note:{note.id}",
        title=note.title,
        text=text,
        raw_meta={"noteId": str(note.id), "contentHash": hash_text(text)},
    )
    return {"documentId": str(document.id), "status": document.status, "duplicate": duplicate}
