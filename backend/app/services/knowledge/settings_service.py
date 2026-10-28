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
    async def effective(
        db: AsyncSession, user_id: uuid.UUID,
    ) -> EffectiveKnowledgeSettings:
        row = await KnowledgeSettingsService.get_or_create(db, user_id)
        model = get_settings().KNOWLEDGE_DISTILL_MODEL
        return EffectiveKnowledgeSettings(
            distill_enabled=bool(row.knowledge_distill_enabled),
            allow_external=bool(row.knowledge_allow_external),
            daily_limit=int(row.knowledge_daily_limit or 0),
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
    ) -> UserAISettings:
        row = await KnowledgeSettingsService.get_or_create(db, user_id)
        if distill_enabled is not None:
            row.knowledge_distill_enabled = distill_enabled
        if allow_external is not None:
            row.knowledge_allow_external = allow_external
        if daily_limit is not None:
            row.knowledge_daily_limit = max(0, daily_limit)
        await db.commit()
        await db.refresh(row)
        return row
