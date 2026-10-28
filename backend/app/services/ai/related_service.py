"""相关笔记与服务端建议链接：语义相关 + 标签相关，标注是否已链接。"""
from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note import Note, NoteLink, NoteNoteTag
from app.services.ai.embedding_service import EmbeddingService
from app.services.note.note_enhance_service import note_preview_text

logger = logging.getLogger(__name__)


class RelatedNoteService:
    @staticmethod
    async def related(
        db: AsyncSession,
        user_id: uuid.UUID,
        note: Note,
        *,
        limit: int = 6,
    ) -> list[dict]:
        """返回相关笔记列表（按相关度），并标注是否已存在链接。"""
        query = f"{note.title}\n{note_preview_text(note, max_len=800)}".strip()
        scored: list[tuple[Note, float]] = []
        seen: set[str] = {str(note.id)}

        # 1) v2 块级语义检索（pgvector 就绪时）
        try:
            from app.services.ai.rag_v2_service import RagV2Service

            rows = await RagV2Service.search_chunks(
                db, user_id, query, top_k=limit * 3,
            ) or []
            for row in rows:
                note_id = str(row.get("note_id"))
                if note_id in seen:
                    continue
                target = await db.get(Note, uuid.UUID(note_id))
                if target and not target.is_deleted and not target.is_encrypted:
                    seen.add(note_id)
                    scored.append((target, float(row.get("score") or 0)))
        except Exception:  # noqa: BLE001
            logger.debug("相关笔记 v2 检索失败，继续尝试 v1", exc_info=True)

        # 2) v1 整篇向量
        if not scored:
            for target, similarity in await EmbeddingService.semantic_search(
                db, user_id, query, limit=limit * 3,
            ):
                if str(target.id) in seen:
                    continue
                seen.add(str(target.id))
                scored.append((target, float(similarity)))

        # 3) 兜底：共同标签
        if not scored:
            tag_rows = await db.execute(
                select(NoteNoteTag.tag_id).where(NoteNoteTag.note_id == note.id),
            )
            tag_ids = [row[0] for row in tag_rows.fetchall()]
            if tag_ids:
                shared_rows = await db.execute(
                    select(NoteNoteTag.note_id, NoteNoteTag.tag_id).where(
                        NoteNoteTag.tag_id.in_(tag_ids),
                        NoteNoteTag.note_id != note.id,
                    ),
                )
                for shared_note_id, _tag_id in shared_rows.fetchall():
                    key = str(shared_note_id)
                    if key in seen:
                        continue
                    target = await db.get(Note, shared_note_id)
                    if target and not target.is_deleted and not target.is_encrypted:
                        seen.add(key)
                        scored.append((target, 0.2))

        linked_rows = await db.execute(
            select(NoteLink.target_id).where(NoteLink.source_id == note.id),
        )
        linked_ids = {str(row[0]) for row in linked_rows.fetchall()}

        results: list[dict] = []
        for target, score in scored[: limit * 2]:
            results.append({
                "id": str(target.id),
                "noteNo": target.note_no,
                "title": target.title,
                "noteType": target.note_type,
                "snippet": note_preview_text(target, max_len=120),
                "score": round(score, 4),
                "linked": str(target.id) in linked_ids,
            })
        return results[:limit]
