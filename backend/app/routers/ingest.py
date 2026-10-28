"""统一知识入库接口：邮件、上传、剪藏、MCP、自写笔记。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, UploadFile
from pydantic import Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_not_guest, require_write_scope
from app.config import get_settings
from app.database import get_db
from app.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.models.user import User
from app.schemas.camel import CamelRequest
from app.services.knowledge.ingest_service import (
    SOURCE_TYPES,
    document_payload,
    get_document,
    ingest,
)

router = APIRouter(prefix="/ingest", tags=["KnowledgeIngest"])

MAX_TEXT_CHARS = 200_000


def _ensure_enabled() -> None:
    if not get_settings().KNOWLEDGE_INGEST_ENABLED:
        raise ForbiddenException("知识入库功能未启用")


class IngestDocumentRequest(CamelRequest):
    source_type: str = "clip"
    external_id: Optional[str] = None
    title: Optional[str] = None
    text: str = Field(..., max_length=MAX_TEXT_CHARS)
    url: Optional[str] = None
    mime: Optional[str] = None
    occurred_at: Optional[datetime] = None
    raw_meta: Optional[dict] = None


@router.post("/documents")
async def ingest_document(
    body: IngestDocumentRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    """把一段文本/HTML 落为源文档并异步入队解析、蒸馏。"""
    _ensure_enabled()
    if body.source_type not in SOURCE_TYPES:
        raise BadRequestException(f"不支持的来源类型: {body.source_type}")
    try:
        document, duplicate = await ingest(
            db,
            user.id,
            source_type=body.source_type,
            external_id=body.external_id,
            title=body.title,
            text=body.text,
            url=body.url,
            mime=body.mime,
            occurred_at=body.occurred_at,
            raw_meta=body.raw_meta,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    return {
        "documentId": str(document.id),
        "status": document.status,
        "duplicate": duplicate,
    }


@router.post("/documents/upload")
async def upload_document(
    file: UploadFile = File(...),
    source_type: str = Query("upload"),
    external_id: Optional[str] = Query(None),
    title: Optional[str] = Query(None),
    url: Optional[str] = Query(None),
    occurred_at: Optional[datetime] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
    _scope: User = Depends(require_write_scope),
):
    """上传 PDF/Office/图片等文件，异步解析后进入蒸馏。"""
    _ensure_enabled()
    if source_type not in SOURCE_TYPES:
        raise BadRequestException(f"不支持的来源类型: {source_type}")
    data = await file.read()
    if not data:
        raise BadRequestException("文件内容为空")
    if len(data) > 50 * 1024 * 1024:
        raise BadRequestException("文件超过 50MB 限制")
    try:
        document, duplicate = await ingest(
            db,
            user.id,
            source_type=source_type,
            external_id=external_id,
            title=title or file.filename,
            data=data,
            url=url,
            mime=file.content_type,
            occurred_at=occurred_at,
            raw_meta={"filename": file.filename or "", "content_type": file.content_type or ""},
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    return {
        "documentId": str(document.id),
        "status": document.status,
        "duplicate": duplicate,
    }


@router.get("/documents/{document_id}")
async def get_ingest_document(
    document_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    document = await get_document(db, user.id, document_id)
    if document is None:
        raise NotFoundException("ingest document", str(document_id))
    payload = document_payload(document)
    payload["rawText"] = document.raw_text
    payload["rawMeta"] = document.raw_meta or {}
    return payload
