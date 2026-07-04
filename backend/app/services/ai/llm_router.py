"""Resolve LLM provider and model from DB or settings."""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.ai import AIModel, UserAISettings
from app.services.ai_providers.base import AIProviderConfig


@dataclass
class ProviderResolution:
    provider: str
    model_id: str
    model_name: str
    endpoint: str | None = None
    api_key: str | None = None
    temperature: float | None = None


class LLMRouter:
    @staticmethod
    async def resolve(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        assistant_model: str | None = None,
        request_model: str | None = None,
        temperature: float | None = None,
    ) -> ProviderResolution:
        settings = get_settings()
        model_ref = request_model or assistant_model

        ai_model: AIModel | None = None
        if model_ref:
            result = await db.execute(
                select(AIModel).where(
                    AIModel.is_deleted == False,  # noqa: E712
                    or_(AIModel.name == model_ref, AIModel.model_id == model_ref),
                )
            )
            ai_model = result.scalar_one_or_none()

        if not ai_model:
            us_result = await db.execute(
                select(UserAISettings).where(UserAISettings.user_id == user_id)
            )
            user_settings = us_result.scalar_one_or_none()
            if user_settings and user_settings.default_model_name:
                result = await db.execute(
                    select(AIModel).where(
                        AIModel.name == user_settings.default_model_name,
                        AIModel.is_deleted == False,  # noqa: E712
                    )
                )
                ai_model = result.scalar_one_or_none()

        if not ai_model:
            result = await db.execute(
                select(AIModel).where(AIModel.is_deleted == False).limit(1)  # noqa: E712
            )
            ai_model = result.scalar_one_or_none()

        if ai_model:
            return ProviderResolution(
                provider=ai_model.provider,
                model_id=ai_model.model_id,
                model_name=ai_model.name,
                endpoint=ai_model.endpoint,
                api_key=ai_model.api_key,
                temperature=temperature,
            )

        return ProviderResolution(
            provider="OLLAMA",
            model_id=settings.OLLAMA_MODEL,
            model_name=f"Ollama/{settings.OLLAMA_MODEL}",
            endpoint=settings.OLLAMA_BASE_URL,
            temperature=temperature or 0.4,
        )
