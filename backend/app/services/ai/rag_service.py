"""RAG service — retrieve relevant notes via full-text search."""
from __future__ import annotations

from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.services.note.note_enhance_service import NoteSearchService, note_preview_text


class RagService:
    @staticmethod
    async def build_context(db: AsyncSession, user_id: UUID, query: str, top_k: int = 5) -> str:
        items, _total = await NoteSearchService.full_text_search(
            db, user_id=user_id, query=query, skip=0, limit=top_k,
        )
        if not items:
            return ""
        parts: list[str] = []
        for note in items:
            preview = note_preview_text(note, max_len=500)
            parts.append(f"- [{note.title}] (id={note.id}): {preview}")
        return "相关笔记：\n" + "\n".join(parts)
