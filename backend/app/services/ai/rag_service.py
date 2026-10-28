"""RAG service — hybrid full-text + semantic retrieval with citations."""
from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note
from app.services.ai.embedding_service import EmbeddingService
from app.services.note.note_enhance_service import NoteSearchService, note_preview_text

logger = logging.getLogger(__name__)


class RagService:
    @staticmethod
    async def _fetch_current_note(
        db: AsyncSession,
        user_id: UUID,
        page_context: dict | None,
    ) -> Note | None:
        if not page_context:
            return None
        entities = page_context.get("selectedEntities") or []
        for ent in entities:
            if not isinstance(ent, dict) or ent.get("type") != "note":
                continue
            raw_id = ent.get("id")
            if not raw_id:
                continue
            try:
                nid = UUID(str(raw_id))
            except ValueError:
                continue
            from app.services.note.note_service import NoteService

            note = await NoteService.get_note(db, nid)
            if note and note.created_by == user_id and not note.is_deleted:
                return note
        return None

    @staticmethod
    def _format_citation(note: Note, preview: str) -> str:
        return f"- [{note.title}](note_id={note.id}): {preview}"

    @staticmethod
    def _citation_payload(note: Note, preview: str, *, source: str) -> dict:
        """结构化引用：前端据此渲染可点击芯片并跳转验证。"""
        return {
            "noteId": str(note.id),
            "noteNo": note.note_no,
            "title": note.title,
            "quote": preview,
            "chunkId": None,
            "headingPath": None,
            "source": source,
        }

    @staticmethod
    async def build_context_with_citations(
        db: AsyncSession,
        user_id: UUID,
        query: str,
        top_k: int = 5,
        page_context: dict | None = None,
    ) -> tuple[str, list[dict]]:
        """构建 RAG 上下文，同时返回结构化引用列表（供 SSE 下发）。"""
        # 优先使用 v2 块级检索（pgvector + RRF）；不可用或无命中时回退 v1
        try:
            from app.services.ai.rag_v2_service import RagV2Service

            v2_result = await RagV2Service.build_context(
                db, user_id, query, top_k=top_k, page_context=page_context,
            )
            if v2_result is not None:
                return v2_result
        except Exception:  # noqa: BLE001 — v2 出错不能影响聊天
            logger.warning("RAG v2 上下文构建失败，回退 v1", exc_info=True)

        parts: list[str] = []
        citations: list[dict] = []
        seen_ids: set[str] = set()

        current = await RagService._fetch_current_note(db, user_id, page_context)
        if current:
            preview = note_preview_text(current, max_len=800)
            parts.append(
                f"## 当前打开的笔记\n{RagService._format_citation(current, preview)}"
            )
            citations.append(
                RagService._citation_payload(current, preview[:200], source="current"),
            )
            seen_ids.add(str(current.id))

        fts_items, _ = await NoteSearchService.full_text_search(
            db, user_id=user_id, query=query, skip=0, limit=top_k, include_shared=True,
        )
        semantic_items = await EmbeddingService.semantic_search(
            db, user_id, query, limit=top_k, include_shared=True,
        )

        merged: list[tuple[Note, float]] = []
        for note in fts_items:
            if str(note.id) not in seen_ids:
                merged.append((note, 0.4))
        for note, sim in semantic_items:
            if str(note.id) in seen_ids:
                continue
            merged.append((note, 0.6 * sim))

        merged.sort(key=lambda x: x[1], reverse=True)
        rag_lines: list[str] = []
        for note, _score in merged[:top_k]:
            if str(note.id) in seen_ids and current and str(note.id) == str(current.id):
                continue
            preview = note_preview_text(note, max_len=500)
            rag_lines.append(RagService._format_citation(note, preview))
            citations.append(
                RagService._citation_payload(note, preview[:200], source="retrieval"),
            )
            seen_ids.add(str(note.id))

        if rag_lines:
            parts.append(
                "## 相关笔记（引用格式 [标题](note_id=...)）\n"
                + "请在回答中引用来源 note_id。\n"
                + "\n".join(rag_lines)
            )

        return "\n\n".join(parts), citations

    @staticmethod
    async def build_context(
        db: AsyncSession,
        user_id: UUID,
        query: str,
        top_k: int = 5,
        page_context: dict | None = None,
    ) -> str:
        context, _citations = await RagService.build_context_with_citations(
            db, user_id, query, top_k=top_k, page_context=page_context,
        )
        return context
