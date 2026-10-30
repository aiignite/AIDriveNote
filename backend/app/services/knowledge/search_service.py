"""知识卡检索：把审核通过的知识卡当成一等检索语料。

卡片是蒸馏产物（摘要 / 要点 / 关键词 / 实体 / 论断），比原笔记更浓缩；
这里提供关键词过滤 + 结构化字段，供 AI 工具与 MCP 调用。
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import Text, cast, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge import IngestDocument, KnowledgeCard

# 只有审核通过 / 已合并的卡片才算「进入知识库」
CARD_STATUSES = ("approved", "merged")


def card_to_payload(card: KnowledgeCard, doc: IngestDocument | None) -> dict[str, Any]:
    payload = card.payload or {}
    return {
        "id": str(card.id),
        "title": card.title,
        "summary": card.summary,
        "knowledgeType": card.knowledge_type,
        "confidence": card.confidence,
        "keyPoints": list(payload.get("key_points") or [])[:7],
        "keywords": list(payload.get("keywords") or [])[:8],
        "topic": payload.get("topic"),
        "noteId": str(card.note_id) if card.note_id else None,
        "source": {
            "type": doc.source_type if doc is not None else None,
            "title": doc.title if doc is not None else None,
            "url": doc.url if doc is not None else None,
            "occurredAt": doc.occurred_at.isoformat()
            if doc is not None and doc.occurred_at
            else None,
        },
    }


async def search_cards(
    db: AsyncSession,
    user_id: uuid.UUID,
    query: str = "",
    *,
    knowledge_type: str | None = None,
    source_type: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """按关键词 / 知识类型 / 来源类型检索已入库的知识卡。"""
    stmt = (
        select(KnowledgeCard, IngestDocument)
        .join(
            IngestDocument,
            IngestDocument.id == KnowledgeCard.document_id,
            isouter=True,
        )
        .where(
            KnowledgeCard.user_id == user_id,
            KnowledgeCard.status.in_(CARD_STATUSES),
        )
        .order_by(KnowledgeCard.created_at.desc())
        .limit(max(1, min(limit, 50)))
    )
    if knowledge_type:
        stmt = stmt.where(KnowledgeCard.knowledge_type == knowledge_type)
    if source_type:
        stmt = stmt.where(IngestDocument.source_type == source_type)
    keyword = (query or "").strip()
    if keyword:
        like = f"%{keyword}%"
        stmt = stmt.where(
            or_(
                KnowledgeCard.title.ilike(like),
                KnowledgeCard.summary.ilike(like),
                cast(KnowledgeCard.payload, Text).ilike(like),
            )
        )
    rows = (await db.execute(stmt)).all()
    return [card_to_payload(card, doc) for card, doc in rows]
