"""公开只读笔记（无需登录，按 token 访问）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.exceptions import NotFoundException
from app.services.note.public_link_service import NotePublicLinkService

router = APIRouter(prefix="/public", tags=["Public"])


@router.get("/notes/{token}")
async def read_public_note(
    token: str,
    db: AsyncSession = Depends(get_db),
):
    note = await NotePublicLinkService.resolve(db, token)
    if note is None:
        raise NotFoundException("Public note")
    return {
        "title": note.title,
        "noteType": note.note_type,
        "content": note.content,
        "updatedAt": note.updated_at.isoformat() if note.updated_at else None,
    }
