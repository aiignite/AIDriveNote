"""RAG v2 索引任务：入队、worker、单篇重建。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import AsyncSessionLocal
from app.models.note.note import Note
from app.services.ai.chunking_service import NoteChunk, chunk_note
from app.services.ai.embedding_service import EmbeddingService
from app.services.ai.rag_v2_schema import rag_v2_available

logger = logging.getLogger(__name__)

WORKER_INTERVAL_SECONDS = 2.0
MAX_ATTEMPTS = 3


def _content_hash(note: Note) -> str:
    payload = json.dumps(
        {"title": note.title, "content": note.content},
        ensure_ascii=False,
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def enqueue_note_index(
    db: AsyncSession,
    note_id: uuid.UUID | str,
    user_id: uuid.UUID | str,
    *,
    reason: str = "update",
) -> bool:
    """把笔记加入索引队列；同一笔记的待处理任务会合并（防抖）。"""
    if not await rag_v2_available(db):
        return False
    await db.execute(
        text("DELETE FROM rag_index_jobs WHERE note_id = :note_id AND status = 'pending'"),
        {"note_id": str(note_id)},
    )
    await db.execute(
        text(
            "INSERT INTO rag_index_jobs (note_id, user_id, reason) "
            "VALUES (:note_id, :user_id, :reason)"
        ),
        {"note_id": str(note_id), "user_id": str(user_id), "reason": reason},
    )
    await db.commit()
    return True


async def _delete_note_chunks(db: AsyncSession, note_id: str) -> None:
    await db.execute(
        text("DELETE FROM rag_chunks WHERE note_id = :note_id"),
        {"note_id": note_id},
    )


async def _mark_document(
    db: AsyncSession,
    note_id: str,
    user_id: str,
    content_hash: str,
    chunk_count: int,
    *,
    status: str = "ok",
    error: str | None = None,
    embedding_model: str | None = None,
) -> None:
    await db.execute(
        text(
            """
            INSERT INTO rag_documents
              (note_id, user_id, content_hash, chunk_count, status, error, indexed_at, embedding_model)
            VALUES (:note_id, :user_id, :content_hash, :chunk_count, :status, :error, now(), :embedding_model)
            ON CONFLICT (note_id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              content_hash = EXCLUDED.content_hash,
              chunk_count = EXCLUDED.chunk_count,
              status = EXCLUDED.status,
              error = EXCLUDED.error,
              indexed_at = now(),
              embedding_model = EXCLUDED.embedding_model
            """
        ),
        {
            "note_id": note_id,
            "user_id": user_id,
            "content_hash": content_hash,
            "chunk_count": chunk_count,
            "status": status,
            "error": error,
            "embedding_model": embedding_model,
        },
    )


async def _note_meta(db: AsyncSession, note: Note) -> tuple[dict[str, Any], Any]:
    """从知识卡/来源文档构建 chunk 元数据；无知识卡时只有 note_type。"""
    from app.models.knowledge import IngestDocument, KnowledgeCard, NoteSource

    meta: dict[str, Any] = {"note_type": note.note_type}
    card_result = await db.execute(
        select(KnowledgeCard)
        .where(
            KnowledgeCard.note_id == note.id,
            KnowledgeCard.status.in_(["approved", "merged"]),
        )
        .order_by(KnowledgeCard.decided_at.desc())
        .limit(1)
    )
    card = card_result.scalar_one_or_none()
    if card is not None:
        payload = card.payload or {}
        meta.update(
            {
                "knowledge_type": card.knowledge_type,
                "keywords": payload.get("keywords") or [],
                "card_id": str(card.id),
                "summary": card.summary,
            }
        )

    source_result = await db.execute(
        select(IngestDocument)
        .join(NoteSource, NoteSource.document_id == IngestDocument.id)
        .where(NoteSource.note_id == note.id)
        .limit(1)
    )
    source = source_result.scalar_one_or_none()
    if source is not None:
        meta.update(
            {
                "source_type": source.source_type,
                "source_id": str(source.id),
                "source_url": source.url,
                "occurred_at": source.occurred_at.isoformat() if source.occurred_at else None,
            }
        )
    return meta, card


def _summary_chunk(card: Any) -> NoteChunk | None:
    if card is None or not (card.summary or "").strip():
        return None
    payload = card.payload or {}
    key_points = [
        str(point).strip() for point in payload.get("key_points") or [] if str(point).strip()
    ]
    content = card.summary.strip()
    if key_points:
        content += "\n" + "\n".join(f"- {point}" for point in key_points[:7])
    return NoteChunk(
        index=0,
        content=content,
        heading_path="摘要",
        token_count=max(1, len(content) // 2),
        is_summary=True,
    )


async def _existing_chunks(db: AsyncSession, note_id: str) -> dict[tuple[str, str], tuple[str, int]]:
    result = await db.execute(
        text(
            "SELECT id, heading_path, content_hash, chunk_index FROM rag_chunks "
            "WHERE note_id = :note_id"
        ),
        {"note_id": note_id},
    )
    existing: dict[tuple[str, str], tuple[str, int]] = {}
    for row in result.fetchall():
        existing[(row[1] or "", row[2])] = (str(row[0]), int(row[3]))
    return existing


async def _sync_chunks(
    db: AsyncSession,
    note: Note,
    user_id: str,
    chunks: list[NoteChunk],
    meta: dict[str, Any],
) -> int:
    """增量同步：未变块保留原 embedding，只嵌入新增块，删除消失块。"""
    note_id = str(note.id)
    existing = await _existing_chunks(db, note_id)
    used: set[str] = set()
    inserted = 0

    pending: list[NoteChunk] = []
    for chunk in chunks:
        key = (chunk.heading_path or "", chunk.content_hash)
        if key in existing and existing[key][0] not in used:
            chunk_id, old_index = existing[key]
            used.add(chunk_id)
            if old_index != chunk.index:
                await db.execute(
                    text("UPDATE rag_chunks SET chunk_index = :index WHERE id = :id"),
                    {"index": chunk.index, "id": chunk_id},
                )
            continue
        pending.append(chunk)

    # 批量嵌入：小模型接口按请求计费/限流，逐块调用既慢又容易 429
    batch_size = 16
    vectors: list[list[float] | None] = []
    for start in range(0, len(pending), batch_size):
        batch = pending[start:start + batch_size]
        batch_vectors = await EmbeddingService.embed_texts(
            [f"{note.title}\n{chunk.heading_path}\n{chunk.content}" for chunk in batch],
        )
        if not batch_vectors or len(batch_vectors) != len(batch):
            await db.rollback()
            raise RuntimeError("嵌入服务不可用，索引任务将重试")
        vectors.extend(batch_vectors)

    for chunk, embedding in zip(pending, vectors):
        if not embedding:
            await db.rollback()
            raise RuntimeError("嵌入服务返回空向量，索引任务将重试")
        chunk_meta = {**meta, "is_summary": chunk.is_summary}
        await db.execute(
            text(
                """
                INSERT INTO rag_chunks
                  (id, note_id, user_id, chunk_index, heading_path, content,
                   content_hash, token_count, meta, embedding, tsv)
                VALUES
                  (:id, :note_id, :user_id, :chunk_index, :heading_path, :content,
                   :content_hash, :token_count, CAST(:meta AS jsonb),
                   CAST(:embedding AS vector),
                   to_tsvector('simple', :content))
                """
            ),
            {
                "id": str(uuid.uuid4()),
                "note_id": note_id,
                "user_id": user_id,
                "chunk_index": chunk.index,
                "heading_path": chunk.heading_path or None,
                "content": chunk.content,
                "content_hash": chunk.content_hash,
                "token_count": chunk.token_count,
                "meta": json.dumps(chunk_meta, ensure_ascii=False),
                "embedding": json.dumps(embedding),
            },
        )
        inserted += 1

    for chunk_id, _index in existing.values():
        if chunk_id not in used:
            await db.execute(
                text("DELETE FROM rag_chunks WHERE id = :id"), {"id": chunk_id},
            )
    return inserted


async def index_note(db: AsyncSession, note: Note) -> int:
    """重建单篇笔记的块与向量，返回块数。"""
    settings = get_settings()
    note_id = str(note.id)
    user_id = str(note.created_by or "")

    if note.created_by is None:
        # 作者账号已删除时 created_by 会被置空，这类无归属笔记不进入检索
        await _delete_note_chunks(db, note_id)
        await db.commit()
        return 0

    if note.is_deleted or note.is_encrypted:
        await _delete_note_chunks(db, note_id)
        await _mark_document(
            db, note_id, user_id, "", 0, status="skipped", error="deleted_or_encrypted",
        )
        await db.commit()
        return 0

    meta, card = await _note_meta(db, note)
    document_text = None
    if note.note_type == "document":
        from app.models.note.document import NoteDocument

        document_text = (
            await db.execute(
                select(NoteDocument.extracted_text).where(
                    NoteDocument.note_id == note.id,
                ),
            )
        ).scalar_one_or_none()
    chunks = chunk_note(
        note.title,
        note.content if isinstance(note.content, dict) else {},
        note.note_type,
        target_chars=settings.RAG_V2_CHUNK_SIZE,
        overlap_chars=settings.RAG_V2_CHUNK_OVERLAP,
        text_override=document_text,
    )
    summary = _summary_chunk(card)
    if summary is not None:
        chunks = [summary] + chunks
    for index, chunk in enumerate(chunks):
        chunk.index = index

    await _sync_chunks(db, note, user_id, chunks, meta)
    await _mark_document(
        db,
        note_id,
        user_id,
        _content_hash(note),
        len(chunks),
        embedding_model=await EmbeddingService.effective_model_name(),
    )
    await db.commit()
    return len(chunks)


async def _claim_jobs(db: AsyncSession, limit: int) -> list[dict[str, Any]]:
    result = await db.execute(
        text(
            """
            UPDATE rag_index_jobs
            SET status = 'running', attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM rag_index_jobs
              WHERE status = 'pending' AND scheduled_at <= now()
              ORDER BY scheduled_at
              LIMIT :limit
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id, note_id, user_id, attempts
            """
        ),
        {"limit": limit},
    )
    rows = [dict(row._mapping) for row in result.fetchall()]
    await db.commit()
    return rows


async def _finish_job(
    db: AsyncSession,
    job_id: int,
    *,
    error: str | None,
    attempts: int,
) -> None:
    if error is None:
        await db.execute(
            text("DELETE FROM rag_index_jobs WHERE id = :id"),
            {"id": job_id},
        )
    elif attempts >= MAX_ATTEMPTS:
        await db.execute(
            text("UPDATE rag_index_jobs SET status = 'failed', error = :error WHERE id = :id"),
            {"id": job_id, "error": error[:1000]},
        )
    else:
        await db.execute(
            text(
                "UPDATE rag_index_jobs SET status = 'pending', error = :error, "
                "scheduled_at = now() + interval '30 seconds' WHERE id = :id"
            ),
            {"id": job_id, "error": error[:1000]},
        )
    await db.commit()


async def process_pending_jobs(limit: int = 3) -> int:
    """处理一批索引任务，返回处理条数。"""
    async with AsyncSessionLocal() as db:
        if not await rag_v2_available(db):
            return 0
        jobs = await _claim_jobs(db, limit)
        for job in jobs:
            try:
                note = await db.get(Note, uuid.UUID(str(job["note_id"])))
                if note is None:
                    raise RuntimeError("笔记不存在")
                count = await index_note(db, note)
                await _finish_job(db, int(job["id"]), error=None, attempts=int(job["attempts"]))
                logger.info("RAG 索引完成：note=%s chunks=%s", job["note_id"], count)
            except Exception as exc:  # noqa: BLE001 — 任务失败必须落库后继续
                await db.rollback()
                logger.warning("RAG 索引失败：note=%s err=%s", job["note_id"], exc)
                await _finish_job(
                    db, int(job["id"]), error=str(exc), attempts=int(job["attempts"]),
                )
        return len(jobs)


async def run_index_worker(stop_event: asyncio.Event) -> None:
    """常驻索引 worker；由 lifespan 启动，关停时通过 stop_event 退出。"""
    while not stop_event.is_set():
        try:
            processed = await process_pending_jobs()
            await asyncio.sleep(0.2 if processed else WORKER_INTERVAL_SECONDS)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("RAG 索引 worker 异常，继续下一轮")
            await asyncio.sleep(WORKER_INTERVAL_SECONDS)
