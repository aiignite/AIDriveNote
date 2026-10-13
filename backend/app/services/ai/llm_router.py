"""Resolve LLM provider and model from DB or settings."""
from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.ai import AIModel
from app.services.ai.ownership import find_model_by_ref, resolve_default_model
from app.services.secret_crypto import decrypt_secret


@dataclass
class ProviderResolution:
    provider: str
    model_id: str
    model_name: str
    endpoint: str | None = None
    api_key: str | None = None
    temperature: float | None = None
    supports_image: bool = False


class LLMRouter:
    @staticmethod
    async def resolve(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        assistant_model: str | None = None,
        request_model: str | None = None,
        temperature: float | None = None,
        is_guest: bool = False,
    ) -> ProviderResolution:
        """解析本次请求使用的模型。

        **所有候选查询都限定在当前用户可见范围内**（本人创建的 + 系统种子）。
        匿名用户（``is_guest=True``）只能使用自己创建的模型与 provider 为
        ``OPENCODE`` 的系统公共免费模型（匿名通道，不携带任何站点 Key）——
        其余系统种子通常指向管理员配置的付费 Key，不对外暴露。
        """
        settings = get_settings()
        model_ref = request_model or assistant_model

        ai_model: AIModel | None = None
        if model_ref:
            ai_model = await find_model_by_ref(db, user_id, model_ref, is_guest=is_guest)

        if not ai_model:
            ai_model = await resolve_default_model(db, user_id, is_guest=is_guest)

        if ai_model:
            model_ref_lower = f"{ai_model.name} {ai_model.model_id}".lower()
            vision_name_hint = any(
                token in model_ref_lower
                for token in ("vision", "vl", "llava", "minimax-m", "gpt-4o", "gemini")
            )
            return ProviderResolution(
                provider=ai_model.provider,
                model_id=ai_model.model_id,
                model_name=ai_model.name,
                endpoint=ai_model.endpoint,
                # 落库为密文（enc:: 前缀），出站调用前解密；存量明文自动兼容
                api_key=decrypt_secret(ai_model.api_key),
                temperature=temperature,
                supports_image=bool(ai_model.supports_image) or vision_name_hint,
            )

        # 库中无可用模型时的兜底：
        # 匿名用户绝不能回退到 env 配置（那是站点所有者的模型与 Key），直接失败。
        if is_guest:
            raise NoAvailableModelError()

        return ProviderResolution(
            provider="OLLAMA",
            model_id=settings.OLLAMA_MODEL,
            model_name=f"Ollama/{settings.OLLAMA_MODEL}",
            endpoint=settings.OLLAMA_BASE_URL,
            temperature=temperature or 0.4,
        )


class NoAvailableModelError(Exception):
    """当前用户作用域内没有任何可用模型。

    目前仅匿名用户会触发：他们的数据到期即被清除，不能也不应借用
    系统管理员配置的模型与环境变量兜底。
    """

    def __str__(self) -> str:
        return "当前没有可用的 AI 模型，请先在「设置 → 模型」中添加一个模型后再使用 AI 功能"

