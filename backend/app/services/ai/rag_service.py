"""RAG service — hybrid full-text + semantic retrieval with citations."""
from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note
from app.services.ai.embedding_service import EmbeddingService
from app.services.note.note_enhance_service import NoteSearchService, note_preview_text


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
    async def build_context(
        db: AsyncSession,
        user_id: UUID,
        query: str,
        top_k: int = 5,
        page_context: dict | None = None,
    ) -> str:
        parts: list[str] = []
        seen_ids: set[str] = set()

        current = await RagService._fetch_current_note(db, user_id, page_context)
        if current:
            preview = note_preview_text(current, max_len=800)
            parts.append(
                f"## 当前打开的笔记\n{RagService._format_citation(current, preview)}"
            )
            seen_ids.add(str(current.id))

        fts_items, _ = await NoteSearchService.full_text_search(
            db, user_id=user_id, query=query, skip=0, limit=top_k,
        )
        semantic_items = await EmbeddingService.semantic_search(
            db, user_id, query, limit=top_k,
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
            seen_ids.add(str(note.id))

        if rag_lines:
            parts.append(
                "## 相关笔记（引用格式 [标题](note_id=...)）\n"
                + "请在回答中引用来源 note_id。\n"
                + "\n".join(rag_lines)
            )

        if not parts:
            return ""
        return "\n\n".join(parts)
