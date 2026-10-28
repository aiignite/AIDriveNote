"""合并建议：用现有 RAG 检索找相似笔记，仅建议、不自动合并。"""
from __future__ import annotations

import re
import uuid
from difflib import SequenceMatcher

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.note.note import Note, NoteNoteTag, NoteTag
from app.services.ai.rag_v2_service import search_chunks

# RRF 中同一块同时命中向量与全文的理论最高分：2 / (k + 1)
MAX_RRF_SCORE = 2.0 / 61.0


def _normalize(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").lower())


async def suggest_merge(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    title: str,
    summary: str,
    tags: list[str],
) -> tuple[uuid.UUID | None, float]:
    """返回 (候选笔记 ID, 相似度)；低于阈值返回 (None, 分数)。"""
    query = f"{title}\n{summary}".strip()
    if not query:
        return None, 0.0

    rows = await search_chunks(db, user_id, query, top_k=5)
    if not rows:
        return None, 0.0

    # 同一笔记只保留最高分块
    best_rows: dict[str, tuple[int, dict]] = {}
    for index, row in enumerate(rows):
        note_id = str(row.get("note_id") or "")
        if note_id and note_id not in best_rows:
            best_rows[note_id] = (index, row)
    if not best_rows:
        return None, 0.0

    note_ids = [uuid.UUID(note_id) for note_id in best_rows]
    result = await db.execute(select(Note).where(Note.id.in_(note_ids)))
    notes = {str(note.id): note for note in result.scalars().all()}

    tag_result = await db.execute(
        select(NoteNoteTag.note_id, NoteTag.name)
        .join(NoteTag, NoteTag.id == NoteNoteTag.tag_id)
        .where(NoteNoteTag.note_id.in_(note_ids))
    )
    note_tags: dict[str, set[str]] = {}
    for note_id, name in tag_result.all():
        note_tags.setdefault(str(note_id), set()).add((name or "").lower())

    input_tags = {tag.lower() for tag in tags if tag}
    best_note_id: uuid.UUID | None = None
    best_score = 0.0
    for note_id, (_index, row) in best_rows.items():
        note = notes.get(note_id)
        if note is None or note.is_deleted:
            continue
        rrf = min(1.0, float(row.get("score") or 0.0) / MAX_RRF_SCORE)
        title_sim = SequenceMatcher(None, _normalize(title), _normalize(note.title)).ratio()
        existing_tags = note_tags.get(note_id, set())
        union = input_tags | existing_tags
        overlap = len(input_tags & existing_tags) / len(union) if union else 0.0
        score = 0.5 * rrf + 0.3 * title_sim + 0.2 * overlap
        if score > best_score:
            best_score = score
            best_note_id = note.id

    if best_score < get_settings().KNOWLEDGE_MERGE_THRESHOLD:
        return None, round(best_score, 4)
    return best_note_id, round(best_score, 4)
