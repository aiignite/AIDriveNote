"""知识入库：源文档幂等落库与两阶段任务入队。"""
from __future__ import annotations

import hashlib
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge import IngestDocument, IngestJob

SOURCE_TYPES = {"email", "upload", "clip", "web_clip", "mcp", "note", "kb"}

# backend/uploads/ingest：仅供异步解析临时使用，解析成功后删除
UPLOAD_DIR = Path(__file__).resolve().parents[3] / "uploads" / "ingest"


def hash_text(text: str) -> str:
    return hashlib.sha256((text or "").strip().encode("utf-8")).hexdigest()


def hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_suffix(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if not suffix or len(suffix) > 12 or not suffix[1:].isalnum():
        return ""
    return suffix


async def enqueue_ingest_job(db: AsyncSession, document_id: uuid.UUID, stage: str) -> None:
    """同文档同 stage 的 pending 任务先删后插，避免重复消费。"""
    await db.execute(
        delete(IngestJob).where(
            IngestJob.document_id == document_id,
            IngestJob.stage == stage,
            IngestJob.status == "pending",
        )
    )
    db.add(IngestJob(document_id=document_id, stage=stage, status="pending"))


async def ingest(
    db: AsyncSession,
    user_id: uuid.UUID,
    *,
    source_type: str,
    external_id: str | None,
    title: str | None,
    text: str | None = None,
    data: bytes | None = None,
    url: str | None = None,
    mime: str | None = None,
    occurred_at: datetime | None = None,
    raw_meta: dict[str, Any] | None = None,
    kb_file_id: uuid.UUID | None = None,
) -> tuple[IngestDocument, bool]:
    """落库并返回 (文档, 是否重复)。请求内不解析、不调模型。"""
    source_type = (source_type or "").strip().lower()
    if source_type not in SOURCE_TYPES:
        raise ValueError(f"不支持的来源类型: {source_type}")
    if data is None and not (text or "").strip():
        raise ValueError("文档内容不能为空")

    digest = hash_bytes(data) if data is not None else hash_text(text or "")
    external = (external_id or digest).strip()[:512] or digest

    existing = await db.execute(
        select(IngestDocument).where(
            IngestDocument.user_id == user_id,
            IngestDocument.source_type == source_type,
            IngestDocument.external_id == external,
            IngestDocument.content_hash == digest,
        )
    )
    duplicate = existing.scalar_one_or_none()
    if duplicate is not None:
        return duplicate, True

    cleaned_title = (title or "").strip()[:200]
    if not cleaned_title:
        first_line = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
        cleaned_title = (first_line or "未命名文档")[:200]

    document_id = uuid.uuid4()
    meta = dict(raw_meta or {})
    file_path: str | None = None
    if data is not None:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        saved = UPLOAD_DIR / f"{document_id}{_safe_suffix(meta.get('filename'))}"
        saved.write_bytes(data)
        file_path = str(saved)
        meta.setdefault("filename", meta.get("filename") or "")
        meta["file_path"] = file_path
        meta["size"] = len(data)

    document = IngestDocument(
        id=document_id,
        user_id=user_id,
        source_type=source_type,
        external_id=external,
        content_hash=digest,
        title=cleaned_title,
        url=(url or "").strip() or None,
        mime=mime,
        occurred_at=occurred_at or datetime.now(timezone.utc),
        raw_text=None if data is not None else text,
        raw_meta=meta,
        status="received",
        kb_file_id=kb_file_id,
    )
    db.add(document)
    await enqueue_ingest_job(db, document_id, "parse")
    await db.commit()
    await db.refresh(document)
    return document, False


async def get_document(
    db: AsyncSession, user_id: uuid.UUID, document_id: uuid.UUID,
) -> IngestDocument | None:
    result = await db.execute(
        select(IngestDocument).where(
            IngestDocument.id == document_id,
            IngestDocument.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


def document_payload(document: IngestDocument) -> dict[str, Any]:
    return {
        "id": str(document.id),
        "sourceType": document.source_type,
        "title": document.title,
        "url": document.url,
        "mime": document.mime,
        "status": document.status,
        "occurredAt": document.occurred_at.isoformat() if document.occurred_at else None,
        "receivedAt": document.received_at.isoformat() if document.received_at else None,
        "parser": document.parser,
        "parseMeta": document.parse_meta or {},
        "error": document.error,
        "noteId": str(document.note_id) if document.note_id else None,
        "hasText": bool(document.raw_text),
    }
