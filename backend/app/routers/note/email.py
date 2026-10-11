"""笔记邮件发送 API —— 把当前打开/选中的笔记发送到指定邮箱。"""
from __future__ import annotations

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.exceptions import ForbiddenException, NotFoundException
from app.models.user import User
from app.services.email_service import EmailService
from app.services.note.mail_render import build_note_html
from app.services.note.note_lock_service import NoteLockService
from app.services.note.note_service import NoteService

router = APIRouter(prefix="/notes/email", tags=["Note Email"])


class NoteEmailSend(BaseModel):
    """发送笔记到邮箱的请求体。"""

    note_id: UUID
    to: str = Field(..., description="收件人地址，支持逗号分隔多个")
    subject: Optional[str] = Field(default=None, description="邮件标题；留空则用笔记标题")
    message: Optional[str] = Field(default=None, description="附言；留空则不带附言")


class NoteEmailSendResult(BaseModel):
    """发送结果。"""

    sent: bool
    recipients: list[str]
    subject: str
    mocked: bool


@router.post("/send", response_model=NoteEmailSendResult)
async def send_note_email(
    payload: NoteEmailSend,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> NoteEmailSendResult:
    """把指定笔记渲染成 HTML 正文并发送。

    仅笔记所有者或具备编辑权的协作者可发送，避免把他人私有笔记外泄。
    """
    note = await NoteService.get_note(db, payload.note_id)
    if not note:
        raise NotFoundException("Note", str(payload.note_id))

    # 与编辑接口同一套权限判定：有 created_by 时必须是本人，或共享权限达到编辑级
    if note.created_by and note.created_by != current_user.id:
        from app.services.note.note_enhance_service import NoteShareService

        can_edit = await NoteShareService.user_can_edit(db, note, current_user.id)
        if not can_edit:
            raise ForbiddenException("无权发送该笔记")

    # 加密文档正文为密文，禁止外发，避免导出乱码或意外泄露
    if await NoteLockService.resolve_lock(db, note):
        raise ForbiddenException("加密文档不支持发送邮件")

    subject = (payload.subject or "").strip() or note.title or "AIDriveNote 笔记"

    html_body, text_body = build_note_html(
        title=note.title or "无标题笔记",
        note_type=note.note_type,
        content=note.content,
        note_no=note.note_no or "",
        sender_name=current_user.name or current_user.email,
    )

    # 用户附言插在正文之前，作为独立段落
    if payload.message and payload.message.strip():
        html_body = _prepend_message(html_body, payload.message.strip())
        text_body = f"{payload.message.strip()}\n\n{text_body}"

    recipients = await EmailService.send_note(
        to_raw=payload.to,
        subject=subject,
        html_body=html_body,
        text_body=text_body,
    )

    from app.config import get_settings

    return NoteEmailSendResult(
        sent=True,
        recipients=recipients,
        subject=subject,
        mocked=get_settings().EMAIL_MOCK,
    )


def _prepend_message(html_body: str, message: str) -> str:
    """把用户附言插到正文卡片的最前面。"""
    from html import escape

    safe = escape(message).replace("\n", "<br>")
    note_block = (
        '<div style="margin:0 0 20px;padding:12px 16px;background:#fff7ed;'
        'border-left:3px solid #f97316;border-radius:6px;font-size:14px;'
        f'line-height:1.7;color:#7c2d12;">{safe}</div>'
    )
    marker = '<h1 style="margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;line-height:1.4;">'
    idx = html_body.find(marker)
    if idx == -1:
        return html_body
    # 插到标题之后（标题块结束处）
    close = html_body.find("</h1>", idx)
    if close == -1:
        return html_body
    insert_at = close + len("</h1>")
    return html_body[:insert_at] + note_block + html_body[insert_at:]
