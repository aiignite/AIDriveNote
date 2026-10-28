"""知识库资产：本地文件清单登记、PDF 文本抽取、搜索与转笔记。"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from pathlib import PurePosixPath
from typing import Optional

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user, require_not_guest
from app.config import get_settings
from app.database import get_db
from app.exceptions import BadRequestException, NotFoundException
from app.models.kb import KbFile, KbRoot
from app.models.user import User
from app.services.knowledge.ingest_service import ingest
from app.services.note import document_storage
from app.services.note.kb_service import KbService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/kb", tags=["KnowledgeBase"])

MAX_KB_FILE_BYTES = 50 * 1024 * 1024


class KbRootCreate(BaseModel):
    name: str
    folderId: Optional[uuid.UUID] = None


class KbManifestFile(BaseModel):
    path: str
    hash: str
    size: Optional[int] = 0
    mime: Optional[str] = None


class KbManifestRequest(BaseModel):
    files: list[KbManifestFile] = []


class KbManifestResult(BaseModel):
    toUpload: list[str]
    unchanged: int
    missing: list[str]
    total: int


class KbRootOut(BaseModel):
    id: str
    name: str
    folderId: Optional[str] = None
    createdAt: Optional[str] = None


class KnowledgeRootOut(BaseModel):
    rootId: str
    folderId: str
    folderName: str


class KbFileOut(BaseModel):
    id: str
    rootId: str
    path: str
    mime: Optional[str] = None
    size: int
    status: str
    isProtected: bool
    noteId: Optional[str] = None
    hasText: bool
    viewable: bool = False
    updatedAt: Optional[str] = None


def _root_out(root: KbRoot) -> KbRootOut:
    return KbRootOut(
        id=str(root.id),
        name=root.name,
        folderId=str(root.folder_id) if root.folder_id else None,
        createdAt=root.created_at.isoformat() if root.created_at else None,
    )


def _file_out(record: KbFile) -> KbFileOut:
    ext = PurePosixPath(record.path).suffix.lower()
    allowed = document_storage.ALLOWED_DOCUMENTS.get(ext)
    return KbFileOut(
        id=str(record.id),
        rootId=str(record.root_id),
        path=record.path,
        mime=record.mime,
        size=record.size,
        status=record.status,
        isProtected=record.is_protected,
        noteId=str(record.note_id) if record.note_id else None,
        hasText=bool(record.extracted_text),
        viewable=bool(record.storage_path and allowed and allowed[1]),
        updatedAt=record.updated_at.isoformat() if record.updated_at else None,
    )


@router.get("/roots", response_model=list[KbRootOut])
async def list_roots(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return [_root_out(root) for root in await KbService.list_roots(db, user.id)]


@router.post("/roots", response_model=KbRootOut)
async def create_root(
    body: KbRootCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    root = await KbService.ensure_root(
        db, user.id, name=body.name.strip() or "知识库", folder_id=body.folderId,
    )
    return _root_out(root)


@router.post("/roots/knowledge", response_model=KnowledgeRootOut)
async def ensure_knowledge_root(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    """确保知识库根文件夹存在：根级「知识库」文件夹，系统保护、不可删除。"""
    root, folder = await KbService.ensure_knowledge_root(db, user.id)
    return KnowledgeRootOut(
        rootId=str(root.id),
        folderId=str(folder.id),
        folderName=folder.name,
    )


@router.post("/roots/{root_id}/manifest", response_model=KbManifestResult)
async def sync_manifest(
    root_id: uuid.UUID,
    body: KbManifestRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    """客户端上报文件清单 → 服务端返回需要上传的路径。"""
    root = await KbService.get_root(db, user.id, root_id)
    if root is None:
        raise NotFoundException("KB root")
    result = await KbService.sync_manifest(
        db,
        user.id,
        root,
        [item.model_dump() for item in body.files],
    )
    return KbManifestResult(**result)


@router.post("/roots/{root_id}/files", response_model=KbFileOut)
async def upload_kb_file(
    root_id: uuid.UUID,
    path: str = Query(..., min_length=1, max_length=2000),
    is_protected: bool = Query(False),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    root = await KbService.get_root(db, user.id, root_id)
    if root is None:
        raise NotFoundException("KB root")
    data = await file.read()
    if len(data) > MAX_KB_FILE_BYTES:
        raise BadRequestException("文件超过 50MB 限制")
    record = await KbService.upload_file(
        db,
        user.id,
        root,
        path=path,
        data=data,
        mime=file.content_type,
        is_protected=is_protected,
    )
    if (
        get_settings().KNOWLEDGE_INGEST_ENABLED
        and get_settings().KNOWLEDGE_AUTO_INGEST_KB_UPLOAD
        and record.extracted_text
        and not record.is_protected
    ):
        try:
            await ingest(
                db,
                user.id,
                source_type="kb",
                external_id=f"kb:{record.root_id}:{record.path}",
                title=PurePosixPath(record.path).stem or record.path,
                text=record.extracted_text,
                mime=record.mime,
                kb_file_id=record.id,
                raw_meta={
                    "path": record.path,
                    "filename": PurePosixPath(record.path).name,
                    "rootId": str(record.root_id),
                },
            )
        except Exception:  # noqa: BLE001 — 自动入库失败不应阻断资产登记
            logger.warning("KB 资产自动入库失败: %s", record.path, exc_info=True)
    return _file_out(record)


@router.get("/files", response_model=list[KbFileOut])
async def list_files(
    query: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    records = await KbService.list_files(db, user.id, query=query, limit=limit)
    return [_file_out(record) for record in records]


@router.get("/files/{file_id}/content")
async def download_kb_file(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    record = await KbService.get_file(db, user.id, file_id)
    if record is None:
        raise NotFoundException("KB file")
    if not record.storage_path:
        raise NotFoundException("KB file content")
    path = document_storage.resolve_path(record.storage_path)
    if path is None:
        raise NotFoundException("KB file content")
    return FileResponse(
        path,
        media_type=record.mime or "application/octet-stream",
        filename=PurePosixPath(record.path).name,
        content_disposition_type="attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
        },
    )


@router.post("/files/{file_id}/to-note")
async def convert_to_note(
    file_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    record = await KbService.get_file(db, user.id, file_id)
    if record is None:
        raise NotFoundException("KB file")
    note = await KbService.to_note(db, user.id, record)
    return {"noteId": str(note.id), "title": note.title, "noteType": note.note_type}
