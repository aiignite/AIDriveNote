"""RAG v2 索引任务：入队、worker、单篇重建。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import AsyncSessionLocal
from app.models.note.note import Note
from app.services.ai.chunking_service import chunk_note
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
) -> None:
    await db.execute(
        text(
            """
            INSERT INTO rag_documents
              (note_id, user_id, content_hash, chunk_count, status, error, indexed_at)
            VALUES (:note_id, :user_id, :content_hash, :chunk_count, :status, :error, now())
            ON CONFLICT (note_id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              content_hash = EXCLUDED.content_hash,
              chunk_count = EXCLUDED.chunk_count,
              status = EXCLUDED.status,
              error = EXCLUDED.error,
              indexed_at = now()
            """
        ),
        {
            "note_id": note_id,
            "user_id": user_id,
            "content_hash": content_hash,
            "chunk_count": chunk_count,
            "status": status,
            "error": error,
        },
    )


async def index_note(db: AsyncSession, note: Note) -> int:
    """重建单篇笔记的块与向量，返回块数。"""
    settings = get_settings()
    note_id = str(note.id)
    user_id = str(note.created_by or "")

    if note.is_deleted or note.is_encrypted:
        await _delete_note_chunks(db, note_id)
        await _mark_document(
            db, note_id, user_id, "", 0, status="skipped", error="deleted_or_encrypted",
        )
        await db.commit()
        return 0

    chunks = chunk_note(
        note.title,
        note.content if isinstance(note.content, dict) else {},
        note.note_type,
        target_chars=settings.RAG_V2_CHUNK_SIZE,
        overlap_chars=settings.RAG_V2_CHUNK_OVERLAP,
    )

    await _delete_note_chunks(db, note_id)

    inserted = 0
    for chunk in chunks:
        embedding = await EmbeddingService.embed_text(
            f"{note.title}\n{chunk.heading_path}\n{chunk.content}"[:8000],
        )
        if not embedding:
            await db.rollback()
            raise RuntimeError("嵌入服务不可用，索引任务将重试")
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
                "meta": json.dumps({"note_type": note.note_type}, ensure_ascii=False),
                "embedding": json.dumps(embedding),
            },
        )
        inserted += 1

    await _mark_document(db, note_id, user_id, _content_hash(note), inserted)
    await db.commit()
    return inserted


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
