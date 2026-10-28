"""公开只读笔记（无需登录，按 token 访问）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.exceptions import NotFoundException
from app.services.note import document_service, document_storage
from app.services.note.note_lock_service import NoteLockService
from app.services.note.public_link_service import NotePublicLinkService

router = APIRouter(prefix="/public", tags=["Public"])


def _document_payload(document) -> dict | None:
    if document is None:
        return None
    meta = document_service.build_document_meta(document)
    return {
        "fileName": meta["file_name"],
        "mime": meta["mime"],
        "ext": meta["ext"],
        "sizeBytes": meta["size_bytes"],
        "pageCount": meta["page_count"],
        "etag": meta["etag"],
        "viewable": meta["viewable"],
        "extractStatus": meta["extract_status"],
    }


@router.get("/notes/{token}")
async def read_public_note(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    note = await NotePublicLinkService.resolve(db, token)
    if note is None:
        raise NotFoundException("Public note")
    if await NoteLockService.resolve_lock(db, note):
        raise NotFoundException("Public note")
    document = (
        await document_service.get_document(db, note.id)
        if note.note_type == "document" else None
    )
    return {
        "title": note.title,
        "noteType": note.note_type,
        "content": note.content,
        "description": note.description,
        "document": _document_payload(document),
        "updatedAt": note.updated_at.isoformat() if note.updated_at else None,
    }


@router.get("/notes/{token}/document")
async def read_public_document(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    note = await NotePublicLinkService.resolve(db, token)
    if note is None or note.note_type != "document":
        raise NotFoundException("Public document")
    if await NoteLockService.resolve_lock(db, note):
        raise NotFoundException("Public document")
    document = await document_service.get_document(db, note.id)
    if document is None:
        raise NotFoundException("Public document")
    path = document_storage.resolve_path(document.storage_path)
    if path is None:
        raise NotFoundException("Public document")
    return FileResponse(
        path,
        media_type=document.mime,
        filename=document.file_name,
        content_disposition_type="attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "private, no-cache",
            "ETag": f'"{document.etag}"',
        },
    )
