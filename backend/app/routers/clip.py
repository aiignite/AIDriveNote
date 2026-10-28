"""网页剪藏接口：供浏览器扩展 / 快捷指令调用。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_write_scope
from app.database import get_db
from app.exceptions import BadRequestException
from app.models.user import User
from app.services.knowledge.ingest_service import ingest
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
    # 知识入库：true 时不创建原始笔记，原文进入知识收件箱
    ingest: bool = False
    sourceType: str = "clip"
    externalId: Optional[str] = None
    occurredAt: Optional[datetime] = None
    rawMeta: Optional[dict] = None


class ClipResult(BaseModel):
    noteId: Optional[str] = None
    title: str
    mode: str = "new"
    documentId: Optional[str] = None


@router.post("", response_model=ClipResult)
async def create_clip(
    body: ClipRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_scope),
):
    """把网页选区保存为 Markdown 笔记；需要带 write 权限的访问令牌。

    ``ingest=true`` 时改走知识入库：原文保存为源文档，异步解析、蒸馏，
    审核通过后才生成知识笔记。
    """
    if body.ingest:
        try:
            document, _duplicate = await ingest(
                db,
                user.id,
                source_type=body.sourceType,
                external_id=body.externalId or body.url,
                title=body.title,
                text=body.text,
                url=body.url,
                occurred_at=body.occurredAt,
                raw_meta=body.rawMeta,
            )
        except ValueError as exc:
            raise BadRequestException(str(exc)) from exc
        return ClipResult(
            title=document.title or body.title or "网页剪藏",
            mode="ingest",
            documentId=str(document.id),
        )
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
