"""知识蒸馏的用户级设置：模型授权、开关与日限额。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.ai.ai import UserAISettings


@dataclass
class EffectiveKnowledgeSettings:
    distill_enabled: bool
    allow_external: bool
    daily_limit: int
    model: str
    configured: bool


class KnowledgeSettingsService:
    @staticmethod
    async def get_or_create(db: AsyncSession, user_id: uuid.UUID) -> UserAISettings:
        result = await db.execute(
            select(UserAISettings).where(UserAISettings.user_id == user_id)
        )
        row = result.scalar_one_or_none()
        if row is None:
            env = get_settings()
            row = UserAISettings(
                user_id=user_id,
                knowledge_distill_enabled=env.KNOWLEDGE_DISTILL_ENABLED,
                knowledge_allow_external=env.KNOWLEDGE_DISTILL_ALLOW_EXTERNAL,
                knowledge_daily_limit=env.KNOWLEDGE_DISTILL_DAILY_LIMIT,
            )
            db.add(row)
            await db.commit()
            await db.refresh(row)
        return row

    @staticmethod
    def _cap_daily_limit(limit: int, *, is_guest: bool) -> int:
        if not is_guest:
            return max(0, int(limit or 0))
        cap = max(0, int(get_settings().GUEST_KNOWLEDGE_DAILY_LIMIT or 0))
        if cap <= 0:
            return max(0, int(limit or 0))
        # 匿名 0（不限制）也必须落到硬上限，不能借设置页绕过成本保护
        return cap if int(limit or 0) <= 0 else min(int(limit), cap)

    @staticmethod
    async def effective(
        db: AsyncSession, user_id: uuid.UUID, *, is_guest: bool = False,
    ) -> EffectiveKnowledgeSettings:
        row = await KnowledgeSettingsService.get_or_create(db, user_id)
        model = (row.knowledge_distill_model or "").strip() or get_settings().KNOWLEDGE_DISTILL_MODEL
        return EffectiveKnowledgeSettings(
            distill_enabled=bool(row.knowledge_distill_enabled),
            allow_external=bool(row.knowledge_allow_external),
            daily_limit=KnowledgeSettingsService._cap_daily_limit(
                int(row.knowledge_daily_limit or 0), is_guest=is_guest,
            ),
            model=model,
            configured=bool(model),
        )

    @staticmethod
    async def update(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        distill_enabled: bool | None = None,
        allow_external: bool | None = None,
        daily_limit: int | None = None,
        model: str | None = None,
        is_guest: bool = False,
    ) -> UserAISettings:
        row = await KnowledgeSettingsService.get_or_create(db, user_id)
        if distill_enabled is not None:
            row.knowledge_distill_enabled = distill_enabled
        if allow_external is not None:
            row.knowledge_allow_external = allow_external
        if daily_limit is not None:
            row.knowledge_daily_limit = KnowledgeSettingsService._cap_daily_limit(
                daily_limit, is_guest=is_guest,
            )
        if model is not None:
            row.knowledge_distill_model = model.strip()[:255] or None
        await db.commit()
        await db.refresh(row)
        return row
