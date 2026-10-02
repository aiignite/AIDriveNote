"""常用词库服务。

维护转写润色与 AI 整理时注入提示词的领域词条（表 ``note_common_terms``）。
提供分页列举、创建、更新、软删除，以及供润色流程使用的「启用词条」读取。
"""
from __future__ import annotations

import logging
import uuid
from typing import Any, Sequence

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.asr import NoteCommonTerm

logger = logging.getLogger(__name__)


class NoteCommonTermService:
    """常用词库（NoteCommonTerm）的静态数据访问服务。"""

    @staticmethod
    def _base_query():
        """返回过滤掉已删除词条的基础查询。"""
        return select(NoteCommonTerm).where(NoteCommonTerm.is_deleted == False)  # noqa: E712

    @staticmethod
    async def get_term(db: AsyncSession, term_id: uuid.UUID) -> NoteCommonTerm | None:
        """按 id 获取未删除的词条。"""
        result = await db.execute(
            NoteCommonTermService._base_query().where(NoteCommonTerm.id == term_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def list_terms(
        db: AsyncSession,
        *,
        keyword: str | None = None,
        enabled_only: bool = False,
        limit: int = 200,
        offset: int = 0,
    ) -> list[NoteCommonTerm]:
        """分页列举词条，可按关键词（词条/别名）与启用状态过滤。"""
        stmt = NoteCommonTermService._base_query()
        if keyword:
            like = f"%{keyword.strip()}%"
            stmt = stmt.where(
                or_(NoteCommonTerm.term.ilike(like), NoteCommonTerm.alias.ilike(like))
            )
        if enabled_only:
            stmt = stmt.where(NoteCommonTerm.is_enabled == True)  # noqa: E712
        stmt = (
            stmt.order_by(
                NoteCommonTerm.usage_count.desc(),
                NoteCommonTerm.created_at.asc(),
            )
            .limit(limit)
            .offset(offset)
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def count_terms(
        db: AsyncSession,
        *,
        keyword: str | None = None,
        enabled_only: bool = False,
    ) -> int:
        """统计符合条件的词条数量（用于分页）。"""
        stmt = select(func.count()).select_from(NoteCommonTerm).where(
            NoteCommonTerm.is_deleted == False  # noqa: E712
        )
        if keyword:
            like = f"%{keyword.strip()}%"
            stmt = stmt.where(
                or_(NoteCommonTerm.term.ilike(like), NoteCommonTerm.alias.ilike(like))
            )
        if enabled_only:
            stmt = stmt.where(NoteCommonTerm.is_enabled == True)  # noqa: E712
        return int((await db.execute(stmt)).scalar_one())

    @staticmethod
    async def create_term(
        db: AsyncSession,
        data: dict[str, Any],
        user_name: str | None = None,
    ) -> NoteCommonTerm:
        """新建词条。

        ``data`` 可含 ``term/alias/remark/is_enabled``；``created_by`` 取
        ``user_name``。
        """
        term = NoteCommonTerm(
            term=str(data.get("term") or "").strip(),
            alias=(str(data["alias"]).strip() if data.get("alias") else None),
            remark=(str(data["remark"]) if data.get("remark") else None),
            is_enabled=bool(data.get("is_enabled", True)),
            created_by=user_name,
        )
        db.add(term)
        await db.commit()
        return await NoteCommonTermService.get_term(db, term.id)

    @staticmethod
    async def update_term(
        db: AsyncSession,
        term_id: uuid.UUID,
        data: dict[str, Any],
    ) -> NoteCommonTerm | None:
        """更新词条字段；词条不存在时返回 None。"""
        term = await NoteCommonTermService.get_term(db, term_id)
        if not term:
            return None
        if "term" in data and data["term"] is not None:
            term.term = str(data["term"]).strip()
        if "alias" in data:
            term.alias = str(data["alias"]).strip() if data["alias"] else None
        if "remark" in data:
            term.remark = str(data["remark"]) if data["remark"] else None
        if "is_enabled" in data and data["is_enabled"] is not None:
            term.is_enabled = bool(data["is_enabled"])
        if "usage_count" in data and data["usage_count"] is not None:
            term.usage_count = int(data["usage_count"])
        await db.commit()
        return await NoteCommonTermService.get_term(db, term_id)

    @staticmethod
    async def delete_term(db: AsyncSession, term_id: uuid.UUID) -> bool:
        """软删除词条；不存在时返回 False。"""
        term = await NoteCommonTermService.get_term(db, term_id)
        if not term:
            return False
        term.is_deleted = True
        term.is_enabled = False
        await db.commit()
        return True

    @staticmethod
    async def list_enabled_terms(db: AsyncSession) -> Sequence[NoteCommonTerm]:
        """返回全部已启用的词条，供润色/整理流程注入提示词。"""
        result = await db.execute(
            NoteCommonTermService._base_query()
            .where(NoteCommonTerm.is_enabled == True)  # noqa: E712
            .order_by(
                NoteCommonTerm.usage_count.desc(),
                NoteCommonTerm.created_at.asc(),
            )
        )
        return list(result.scalars().all())