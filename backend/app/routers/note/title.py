"""笔记标题 API —— 自动推导与 AI 提取。

两条路径：

- ``derive``：从内容取现成标题（Markdown 首行 / 思维导图中心主题 / 流程图首节点）
- ``generate``：调用模型概括出一个标题

两者都只返回结果；是否写入由前端在用户确认后决定。
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.exceptions import AppException, ForbiddenException, NotFoundException
from app.models.note.note import Note
from app.models.user import User
from app.services.note.note_enhance_service import NoteShareService
from app.services.note.note_service import NoteService
from app.services.note.title_derive import derive_title
from app.services.note.title_generator import TitleGenerator

router = APIRouter(prefix="/notes/title", tags=["Note Title"])


async def _load_editable_note(
    db: AsyncSession, note_id: UUID, user: User
) -> Note:
    """取出笔记并校验调用者具备编辑权。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note", str(note_id))
    if note.created_by and note.created_by != user.id:
        if not await NoteShareService.user_can_edit(db, note, user.id):
            raise ForbiddenException("无权操作该笔记")
    return note


class TitleSuggestResponse(BaseModel):
    """标题建议响应。"""

    title: str
    """建议标题；空字符串表示无法生成（调用方应保留原标题）"""


class TitleGenerateRequest(BaseModel):
    """AI 提取标题的请求。"""

    note_id: UUID
    assistant_model: Optional[str] = None
    request_model: Optional[str] = None


@router.post("/derive", response_model=TitleSuggestResponse)
async def derive_note_title(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TitleSuggestResponse:
    """从笔记内容推导标题（不调用模型，零延迟）。

    前端通常不需要单独调它——保存内容时后端已自动填充占位标题；
    这个接口用于「重新从内容取一次标题」的场景。
    """
    note = await _load_editable_note(db, note_id, current_user)
    return TitleSuggestResponse(title=derive_title(note.note_type, note.content))


@router.post("/generate", response_model=TitleSuggestResponse)
async def generate_note_title(
    payload: TitleGenerateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> TitleSuggestResponse:
    """调用 AI 模型为笔记生成标题建议。"""
    note = await _load_editable_note(db, payload.note_id, current_user)
    try:
        title = await TitleGenerator.generate(
            db,
            current_user.id,
            note,
            assistant_model=payload.assistant_model,
            request_model=payload.request_model,
        )
    except AppException:
        raise
    except Exception as exc:  # noqa: BLE001 - 模型不可用属于 502
        raise AppException("AI 标题生成失败，请检查模型配置或稍后重试", status_code=502) from exc

    if not title:
        raise AppException("笔记内容为空，无法生成标题", status_code=400)
    return TitleSuggestResponse(title=title)
