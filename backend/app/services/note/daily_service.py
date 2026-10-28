"""每日笔记与 AI 回顾。"""
from __future__ import annotations

import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note
from app.services.note.note_enhance_service import note_preview_text

logger = logging.getLogger(__name__)

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DAILY_TEMPLATE = """## 今日要事

- 

## 随手记

## 复盘

- 做成了什么：
- 卡在哪里：
"""


def normalize_date(value: str | None) -> str:
    if value and _DATE_RE.match(value):
        return value
    return datetime.now().strftime("%Y-%m-%d")


class DailyNoteService:
    @staticmethod
    async def ensure_daily_note(
        db: AsyncSession, user_id: uuid.UUID, date_str: str | None = None,
    ) -> Note:
        target = normalize_date(date_str)
        result = await db.execute(
            select(Note)
            .where(
                Note.created_by == user_id,
                Note.title == target,
                Note.note_type == "markdown",
                Note.is_deleted == False,  # noqa: E712
            )
            .order_by(Note.created_at.desc())
            .limit(1),
        )
        existing = result.scalar_one_or_none()
        if existing is not None:
            return existing

        from app.services.note.note_service import NoteService

        return await NoteService.create_note(db, {
            "title": target,
            "note_type": "markdown",
            "content": {"text": f"# {target}\n\n{DAILY_TEMPLATE}"},
            "created_by": user_id,
            "updated_by": user_id,
        })

    @staticmethod
    async def build_review(
        db: AsyncSession, user_id: uuid.UUID, date_str: str | None = None,
    ) -> dict:
        """把最近 24 小时的笔记交给模型做回顾；模型不可用时返回规则版摘要。"""
        target = normalize_date(date_str)
        since = datetime.now(timezone.utc) - timedelta(days=1)
        result = await db.execute(
            select(Note)
            .where(
                Note.created_by == user_id,
                Note.is_deleted == False,  # noqa: E712
                Note.is_encrypted == False,  # noqa: E712
                Note.updated_at >= since,
            )
            .order_by(Note.updated_at.desc())
            .limit(30),
        )
        notes = list(result.scalars().all())
        if not notes:
            return {
                "date": target,
                "markdown": f"## {target} 回顾\n\n昨天没有更新任何笔记。",
                "noteCount": 0,
                "model": None,
            }

        bullets = "\n".join(
            f"- {note.title}：{note_preview_text(note, max_len=120)}" for note in notes
        )
        fallback = (
            f"## {target} 回顾\n\n"
            f"最近 24 小时更新了 {len(notes)} 篇笔记：\n\n"
            + "\n".join(f"- {note.title}" for note in notes)
        )
        prompt = (
            "你是个人知识管理助手。根据下面最近 24 小时的笔记，写一份中文回顾，"
            "包含：1) 3-5 条要点；2) 未完成的开放事项；3) 建议今天继续推进的两件事。"
            "用 Markdown，不要编造未出现的信息。\n\n" + bullets
        )
        try:
            if os.getenv("AIDRIVE_TESTING") == "1":
                raise RuntimeError("testing: skip llm")
            from app.services.note.recording.llm_dispatch import dispatch_llm

            raw, model_name = await dispatch_llm(
                db,
                system_prompt="你是严谨的个人知识管理助手，只依据给定笔记输出 Markdown。",
                user_prompt=prompt,
                user_id=user_id,
                max_tokens=1200,
                temperature=0.3,
            )
            markdown = (raw or "").strip() or fallback
        except Exception as exc:  # noqa: BLE001 — 模型不可用时保证功能可用
            logger.warning("每日回顾生成失败，使用规则版：%s", exc)
            markdown = fallback
            model_name = None

        return {
            "date": target,
            "markdown": markdown,
            "noteCount": len(notes),
            "model": model_name,
        }
