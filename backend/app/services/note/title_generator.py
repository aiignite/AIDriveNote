"""AI 标题生成 —— 让模型读笔记内容并给出一个凝练的标题。

与自动推导（:mod:`title_derive`）的分工：

- 自动推导是「取现成的」——Markdown 首行、思维导图中心主题，确定性强、零延迟；
- AI 提取是「想一个」——正文没有显式标题时，由模型概括，适合长笔记。

本服务只返回**建议标题**，不直接落库；写入须由调用方（前端确认 / AI 工具）显式执行。
"""
from __future__ import annotations

import logging
import re
import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note
from app.services.ai.llm_router import LLMRouter
from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.factory import AIProviderFactory
from app.services.note.note_enhance_service import note_preview_text

logger = logging.getLogger(__name__)

# 送进模型的正文上限；太长会显著拖慢小模型，且首屏内容已足够概括主题
MAX_CONTENT_CHARS = 2000

# 标题长度约束
MAX_TITLE_LEN = 30

SYSTEM_PROMPT = (
    "你是一个笔记标题生成器。根据笔记内容生成一个简洁、准确的中文标题。\n"
    "要求：\n"
    "1. 直接输出标题本身，不要任何解释、前缀、引号或标点结尾\n"
    "2. 长度不超过 30 个字，能概括核心主题\n"
    "3. 使用与内容相同的语言（中文内容用中文标题）\n"
    "4. 不要用「关于...」开头，直接给出主题"
)

# 模型偶尔会带「标题：」前缀或包裹引号，这里统一剥掉
_PREFIX_RE = re.compile(r"^\s*(?:标题|title)\s*[:：]\s*", re.IGNORECASE)
_WRAPPERS = ("「", "」", "《", "》", "\"", "'", "“", "”", "‘", "’")


def _sanitize(raw: str) -> str:
    """清洗模型输出：剥前缀/引号、压空白、限长。"""
    text = (raw or "").strip()
    text = _PREFIX_RE.sub("", text).strip()
    # 去掉首尾成对引号
    while len(text) >= 2 and text[0] in _WRAPPERS and text[-1] in _WRAPPERS:
        text = text[1:-1].strip()
    # 去掉换行与多余空白（模型偶尔会折行）
    text = re.sub(r"\s+", " ", text).strip()
    # 结尾多余标点
    text = text.rstrip("。，,.、;；:：")
    if len(text) > MAX_TITLE_LEN:
        text = text[: MAX_TITLE_LEN - 1].rstrip() + "…"
    return text


class TitleGenerator:
    """AI 标题生成器。"""

    @staticmethod
    async def generate(
        db: AsyncSession,
        user_id: uuid.UUID,
        note: Note,
        *,
        assistant_model: str | None = None,
        request_model: str | None = None,
        is_guest: bool = False,
    ) -> str:
        """为指定笔记生成建议标题。

        :param db: 数据库会话
        :param user_id: 用户 ID（用于解析该用户可用的模型）
        :param note: 目标笔记
        :param is_guest: 是否匿名账号（只能用其自己创建的模型）
        :returns: 建议标题；无法生成时返回空字符串
        """
        preview = note_preview_text(note, max_len=MAX_CONTENT_CHARS).strip()
        if not preview:
            # 内容为空时退回用旧标题无从提炼，直接让调用方决定
            return ""

        resolution = await LLMRouter.resolve(
            db,
            user_id,
            assistant_model=assistant_model,
            request_model=request_model,
            temperature=0.2,  # 低温度让输出更稳定、少发挥
            is_guest=is_guest,
        )

        provider = AIProviderFactory.create(
            resolution.provider,
            AIProviderConfig(
                model=resolution.model_id,
                base_url=resolution.endpoint,
                api_key=resolution.api_key,
                temperature=resolution.temperature,
            ),
        )

        messages = [
            ChatMessage(role="system", content=SYSTEM_PROMPT),
            ChatMessage(
                role="user",
                content=f"笔记类型：{note.note_type}\n当前标题：{note.title}\n\n内容：\n{preview}",
            ),
        ]

        result = await provider.chat_with_tools(
            messages,
            ChatOptions(model=resolution.model_id, temperature=resolution.temperature or 0.2),
        )

        content: Any = result.get("content") or ""
        if isinstance(content, list):
            # 少数 provider 返回多模态分段数组
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict)
            )

        title = _sanitize(str(content))
        logger.info("AI 生成标题 note=%s -> %r", note.id, title)
        return title
