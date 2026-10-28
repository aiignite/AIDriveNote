"""网页剪藏接口：供浏览器扩展 / 快捷指令调用。"""
from __future__ import annotations

from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_write_scope
from app.database import get_db
from app.exceptions import BadRequestException
from app.models.user import User
from app.services.note.clip_service import ClipService

router = APIRouter(prefix="/clip", tags=["Clip"])


class ClipRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200_000)
    title: Optional[str] = None
    url: Optional[str] = None
    tags: Optional[list[str]] = None
    # 目标文件夹：folderId 精确优先；folderName 按根级名称查找/创建
    folderId: Optional[UUID] = None
    folderName: Optional[str] = None
    createFolder: bool = True
    # new：每次新建；append：追加到 noteId/noteTitle 指定笔记；daily：追加到当天日记
    mode: Literal["new", "append", "daily"] = "new"
    noteId: Optional[UUID] = None
    noteTitle: Optional[str] = None


class ClipResult(BaseModel):
    noteId: str
    title: str
    mode: str = "new"


@router.post("", response_model=ClipResult)
async def create_clip(
    body: ClipRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_scope),
):
    """把网页选区保存为 Markdown 笔记；需要带 write 权限的访问令牌。"""
    try:
        note, applied_mode = await ClipService.create_clip(
            db,
            user.id,
            text=body.text,
            title=body.title,
            url=body.url,
            tags=body.tags,
            folder_id=body.folderId,
            folder_name=body.folderName,
            create_folder=body.createFolder,
            mode=body.mode,
            note_id=body.noteId,
            note_title=body.noteTitle,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    return ClipResult(noteId=str(note.id), title=note.title, mode=applied_mode)
