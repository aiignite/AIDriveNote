"""知识入库 worker：parse → distill 两阶段，失败退避重试。"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.knowledge import IngestDocument, IngestJob
from app.services.knowledge.ingest_service import enqueue_ingest_job
from app.services.knowledge.parsing.registry import parse_bytes, parse_text

logger = logging.getLogger(__name__)

WORKER_INTERVAL_SECONDS = 2.0
MAX_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 30


async def _claim_jobs(db: AsyncSession, limit: int) -> list[dict[str, Any]]:
    if db.bind is not None and db.bind.dialect.name == "sqlite":
        result = await db.execute(
            select(IngestJob)
            .where(
                IngestJob.status == "pending",
                or_(IngestJob.scheduled_at.is_(None), IngestJob.scheduled_at <= func.now()),
            )
            .order_by(IngestJob.scheduled_at)
            .limit(limit)
        )
        jobs = list(result.scalars().all())
        claimed: list[dict[str, Any]] = []
        for job in jobs:
            job.status = "running"
            job.attempts = (job.attempts or 0) + 1
            claimed.append(
                {
                    "id": job.id,
                    "document_id": job.document_id,
                    "stage": job.stage,
                    "attempts": job.attempts,
                }
            )
        await db.commit()
        return claimed

    result = await db.execute(
        text(
            """
            UPDATE ingest_jobs
            SET status = 'running', attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM ingest_jobs
              WHERE status = 'pending' AND scheduled_at <= now()
              ORDER BY scheduled_at
              LIMIT :limit
              FOR UPDATE SKIP LOCKED
            )
            RETURNING id, document_id, stage, attempts
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
    job = await db.get(IngestJob, job_id)
    if job is None:
        return
    if error is None:
        await db.delete(job)
    elif attempts >= MAX_ATTEMPTS:
        job.status = "failed"
        job.error = error[:1000]
    else:
        job.status = "pending"
        job.error = error[:1000]
        job.scheduled_at = datetime.now(timezone.utc) + timedelta(seconds=RETRY_DELAY_SECONDS)
    await db.commit()


def _cleanup_temp_file(doc: IngestDocument) -> None:
    path = (doc.raw_meta or {}).get("file_path")
    if not path:
        return
    try:
        Path(str(path)).unlink(missing_ok=True)
    except OSError:
        logger.debug("清理入库临时文件失败: %s", path)


async def _parse_document(db: AsyncSession, doc: IngestDocument) -> None:
    doc.status = "parsing"
    await db.commit()

    if (doc.raw_text or "").strip():
        parsed = parse_text(doc.raw_text or "", mime=doc.mime, title=doc.title)
    else:
        path = (doc.raw_meta or {}).get("file_path")
        if not path or not Path(str(path)).exists():
            raise RuntimeError("源文件不存在，无法解析")
        data = Path(str(path)).read_bytes()
        parsed = parse_bytes(
            data,
            filename=(doc.raw_meta or {}).get("filename") or doc.title,
            mime=doc.mime,
        )

    doc.raw_text = parsed.text
    doc.parser = parsed.parser
    doc.parse_meta = {**(doc.parse_meta or {}), **parsed.meta}
    doc.status = "parsed"
    doc.parsed_at = datetime.now(timezone.utc)
    doc.error = None
    await enqueue_ingest_job(db, doc.id, "distill")
    await db.commit()
    _cleanup_temp_file(doc)


async def _distill_document(db: AsyncSession, doc: IngestDocument) -> None:
    from app.services.knowledge.knowledge_extract_service import extract_cards, save_cards

    doc.status = "distilling"
    await db.commit()

    drafts = await extract_cards(db, doc, doc.user_id)
    await save_cards(db, doc, drafts)


async def process_pending_ingest_jobs(limit: int = 3) -> int:
    async with AsyncSessionLocal() as db:
        jobs = await _claim_jobs(db, limit)
        for job in jobs:
            job_id = int(job["id"])
            attempts = int(job["attempts"])
            try:
                dtype = uuid.UUID(str(job["document_id"]))
                doc = await db.get(IngestDocument, dtype)
                if doc is None:
                    await _finish_job(db, job_id, error="文档不存在", attempts=attempts)
                    continue
                if job["stage"] == "parse":
                    await _parse_document(db, doc)
                elif job["stage"] == "distill":
                    await _distill_document(db, doc)
                else:
                    raise RuntimeError(f"未知任务阶段: {job['stage']}")
                await _finish_job(db, job_id, error=None, attempts=attempts)
                logger.info("知识入库任务完成：doc=%s stage=%s", doc.id, job["stage"])
            except Exception as exc:  # noqa: BLE001 — 单条失败不影响后续任务
                await db.rollback()
                logger.warning("知识入库任务失败：doc=%s stage=%s err=%s", job["document_id"], job["stage"], exc)
                await _finish_job(db, job_id, error=str(exc), attempts=attempts)
                if attempts >= MAX_ATTEMPTS:
                    failed_doc = await db.get(IngestDocument, uuid.UUID(str(job["document_id"])))
                    if failed_doc is not None:
                        failed_doc.status = "failed"
                        failed_doc.error = str(exc)[:1000]
                        await db.commit()
                        _cleanup_temp_file(failed_doc)
        return len(jobs)


async def run_ingest_worker(stop_event: asyncio.Event) -> None:
    """常驻 worker；多进程部署用 advisory lock 保证只有一个实例消费。"""
    if os.getenv("AIDRIVE_TESTING") == "1":
        return

    async with AsyncSessionLocal() as lock_db:
        locked = True
        try:
            locked = bool(
                (await lock_db.execute(
                    text("SELECT pg_try_advisory_lock(hashtext('ingest_worker'))")
                )).scalar()
            )
        except Exception:  # noqa: BLE001 — 非 PostgreSQL 环境直接运行
            locked = True
        if not locked:
            logger.info("另一个 ingest worker 已持有锁，本实例退出")
            return

        while not stop_event.is_set():
            try:
                processed = await process_pending_ingest_jobs()
                await asyncio.sleep(0.2 if processed else WORKER_INTERVAL_SECONDS)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.exception("知识入库 worker 异常，继续下一轮")
                await asyncio.sleep(WORKER_INTERVAL_SECONDS)
