"""Knowledge tools — 检索已入库的知识卡（蒸馏产物）。"""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
from app.services.knowledge.search_service import search_cards

CATEGORY = "knowledge"

_KNOWLEDGE_TYPES = ["concept", "entity", "topic", "decision", "note"]
_SOURCE_TYPES = ["email", "upload", "clip", "web_clip", "mcp", "note", "kb"]


async def _search_knowledge(
    db: AsyncSession,
    user_id: UUID,
    *,
    query: str | None = None,
    knowledge_type: str | None = None,
    source_type: str | None = None,
    limit: int = 5,
) -> dict[str, Any]:
    cards = await search_cards(
        db,
        user_id,
        query or "",
        knowledge_type=knowledge_type,
        source_type=source_type,
        limit=limit,
    )
    if not cards:
        return {
            "success": True,
            "found": 0,
            "cards": [],
            "hint": "没有匹配的知识卡；可换关键词，或用 list_notes 直接找原始笔记。",
        }
    return {"success": True, "found": len(cards), "cards": cards}


def _register_all() -> None:
    ToolRegistry.register("search_knowledge", {
        "name": "search_knowledge",
        "description": (
            "检索已审核入库的知识卡（蒸馏后的摘要/要点/关键词）。"
            "适合回答“之前整理过什么结论”“有哪些决策/概念”这类问题；"
            "卡片带 noteId，可用 get_note 打开对应知识笔记。"
            "只包含已入库的卡片，原文笔记请用 list_notes。"
        ),
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "关键词，匹配标题/摘要/要点/关键词（可选）"},
            "knowledge_type": {
                "type": "string",
                "enum": _KNOWLEDGE_TYPES,
                "description": "按知识类型过滤（可选）",
            },
            "source_type": {
                "type": "string",
                "enum": _SOURCE_TYPES,
                "description": "按来源类型过滤：upload 上传文档 / note 自写笔记 / clip 剪藏 等（可选）",
            },
            "limit": {"type": "integer", "description": "返回数量，默认 5，最多 50"},
        }},
    }, _search_knowledge, CATEGORY, "检索知识卡")


_register_all()
