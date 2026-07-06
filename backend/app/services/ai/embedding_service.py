"""Generate and store note content embeddings for semantic RAG."""
from __future__ import annotations

import logging
import math
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.note.note import Note
from app.services.note.note_enhance_service import note_preview_text

logger = logging.getLogger(__name__)


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class EmbeddingService:
    @staticmethod
    async def embed_text(text: str) -> list[float] | None:
        settings = get_settings()
        payload_text = (text or "").strip()
        if not payload_text:
            return None
        url = f"{settings.OLLAMA_BASE_URL.rstrip('/')}/api/embeddings"
        model = getattr(settings, "OLLAMA_EMBED_MODEL", None) or "nomic-embed-text"
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.post(url, json={"model": model, "prompt": payload_text[:8000]})
                resp.raise_for_status()
                data = resp.json()
                emb = data.get("embedding")
                if isinstance(emb, list) and emb:
                    return [float(x) for x in emb]
        except Exception as exc:
            logger.debug("Embedding unavailable: %s", exc)
        return None

    @staticmethod
    async def update_note_embedding(db: AsyncSession, note: Note) -> None:
        preview = note_preview_text(note, max_len=2000)
        text = f"{note.title}\n{preview}".strip()
        embedding = await EmbeddingService.embed_text(text)
        if embedding:
            note.content_embedding = embedding

    @staticmethod
    async def semantic_search(
        db: AsyncSession,
        user_id: UUID,
        query: str,
        *,
        limit: int = 5,
    ) -> list[tuple[Note, float]]:
        query_emb = await EmbeddingService.embed_text(query)
        if not query_emb:
            return []

        result = await db.execute(
            select(Note).where(
                Note.created_by == user_id,
                Note.is_deleted == False,  # noqa: E712
                Note.content_embedding.isnot(None),
            ).limit(200)
        )
        notes = list(result.scalars().all())
        scored: list[tuple[Note, float]] = []
        for note in notes:
            emb = note.content_embedding
            if isinstance(emb, list) and emb:
                sim = cosine_similarity(query_emb, [float(x) for x in emb])
                if sim > 0.1:
                    scored.append((note, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:limit]
