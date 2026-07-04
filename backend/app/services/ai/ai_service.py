"""AI chat service with assistants, skills, tools, and conversation persistence."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncIterator

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.ai_tools.registry import ToolRegistry
from app.models.ai import AIAssistant, AIConversation, AIMessage
from app.services.ai.llm_router import LLMRouter
from app.services.ai.rag_service import RagService
from app.services.ai.tool_executor import ToolExecutor
from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.factory import AIProviderFactory
from app.services.ai_skills.skill_router import SkillRouter

logger = logging.getLogger(__name__)
MAX_TOOL_ROUNDS = 3


def _build_page_context_prompt(page_context: dict[str, Any] | None) -> str:
    if not page_context:
        return ""
    parts = []
    if page_context.get("contextHint"):
        parts.append(str(page_context["contextHint"]))
    if page_context.get("selectedEntities"):
        parts.append(f"选中实体：{json.dumps(page_context['selectedEntities'], ensure_ascii=False)}")
    return "\n".join(parts)


class AIService:
    @staticmethod
    async def get_assistant(db: AsyncSession, name: str | None) -> AIAssistant | None:
        target = name or "笔记助手"
        result = await db.execute(
            select(AIAssistant).where(
                AIAssistant.name == target,
                AIAssistant.is_deleted == False,  # noqa: E712
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def get_or_create_conversation(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        conversation_id: uuid.UUID | None,
        assistant_name: str | None,
        model_name: str | None,
    ) -> AIConversation:
        if conversation_id:
            result = await db.execute(
                select(AIConversation).where(
                    AIConversation.id == conversation_id,
                    AIConversation.user_id == user_id,
                    AIConversation.is_deleted == False,  # noqa: E712
                )
            )
            conv = result.scalar_one_or_none()
            if conv:
                return conv
        conv = AIConversation(
            user_id=user_id,
            title="新对话",
            assistant_name=assistant_name or "笔记助手",
            model=model_name,
        )
        db.add(conv)
        await db.flush()
        return conv

    @staticmethod
    async def load_history(db: AsyncSession, conversation_id: uuid.UUID) -> list[ChatMessage]:
        result = await db.execute(
            select(AIMessage)
            .where(
                AIMessage.conversation_id == conversation_id,
                AIMessage.is_deleted == False,  # noqa: E712
            )
            .order_by(AIMessage.created_at)
            .limit(20)
        )
        messages = []
        for m in result.scalars().all():
            if m.role in {"user", "assistant", "system"}:
                messages.append(ChatMessage(role=m.role, content=m.content or ""))
        return messages

    @staticmethod
    async def chat_stream(
        db: AsyncSession,
        user_id: uuid.UUID,
        message: str,
        *,
        assistant_name: str | None = None,
        conversation_id: uuid.UUID | None = None,
        page_context: dict[str, Any] | None = None,
        model_id: str | None = None,
    ) -> AsyncIterator[str]:
        assistant = await AIService.get_assistant(db, assistant_name)
        if not assistant:
            yield f"data: {json.dumps({'type': 'error', 'content': '未找到助手'}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return

        resolution = await LLMRouter.resolve(
            db, user_id,
            assistant_model=assistant.model,
            request_model=model_id,
            temperature=assistant.temperature,
        )
        conv = await AIService.get_or_create_conversation(
            db, user_id,
            conversation_id=conversation_id,
            assistant_name=assistant.name,
            model_name=resolution.model_name,
        )

        skill_match = await SkillRouter.resolve_for_page(
            db,
            page_name=(page_context or {}).get("pageName"),
            message=message,
            assistant=assistant,
        )
        system_parts = [assistant.system_prompt]
        if skill_match:
            system_parts.append(f"## 激活技能：{skill_match.skill.name}\n{skill_match.skill.prompt_template}")
        page_hint = _build_page_context_prompt(page_context)
        if page_hint:
            system_parts.append(f"## 页面上下文\n{page_hint}")
        rag = await RagService.build_context(db, user_id, message, top_k=5)
        if rag:
            system_parts.append(rag)

        history = await AIService.load_history(db, conv.id)
        messages = [ChatMessage(role="system", content="\n\n".join(system_parts))]
        messages.extend(history)
        messages.append(ChatMessage(role="user", content=message))

        db.add(AIMessage(conversation_id=conv.id, role="user", content=message))
        await db.flush()

        tool_names = SkillRouter.merge_tool_names(assistant.tools, skill_match.skill if skill_match else None)
        executor = ToolExecutor(db, user_id)
        tool_defs = executor.get_tools_for_assistant(tool_names)
        for td in tool_defs:
            if "type" not in td:
                td_wrapped = {"type": "function", "function": td}
            else:
                td_wrapped = td
        openai_tools = [
            {"type": "function", "function": t.get("function", t)} for t in tool_defs
        ]

        provider = AIProviderFactory.create(
            resolution.provider,
            AIProviderConfig(
                model=resolution.model_id,
                base_url=resolution.endpoint,
                api_key=resolution.api_key,
                temperature=resolution.temperature,
            ),
        )
        options = ChatOptions(
            model=resolution.model_id,
            temperature=resolution.temperature,
            tools=openai_tools or None,
            base_url=resolution.endpoint,
            api_key=resolution.api_key,
        )

        full_content = ""
        all_tool_results: list[dict[str, Any]] = []
        working_messages = list(messages)

        for _round in range(MAX_TOOL_ROUNDS):
            round_content = ""
            round_tool_calls: list[dict[str, Any]] = []

            async for chunk in provider.stream_chat_with_tools(working_messages, options):
                if chunk.get("type") == "content":
                    text = chunk.get("content") or ""
                    round_content += text
                    full_content += text
                    yield f"data: {json.dumps({'type': 'content', 'content': text}, ensure_ascii=False)}\n\n"
                elif chunk.get("type") == "tool_call":
                    round_tool_calls.append(chunk.get("tool_call"))

            if not round_tool_calls:
                break

            working_messages.append(ChatMessage(
                role="assistant",
                content=round_content,
                tool_calls=round_tool_calls,
            ))
            for tc in round_tool_calls:
                fn = tc.get("function") or {}
                name = fn.get("name")
                args = fn.get("arguments") or {}
                if not name:
                    continue
                result = await executor.execute(name, args)
                all_tool_results.append({"tool": name, "result": result})
                yield f"data: {json.dumps({'type': 'tool_result', 'tool': name, 'result': result}, ensure_ascii=False)}\n\n"
                working_messages.append(ChatMessage(
                    role="tool",
                    content=json.dumps(result, ensure_ascii=False),
                ))

        db.add(AIMessage(
            conversation_id=conv.id,
            role="assistant",
            content=full_content,
            tool_results=all_tool_results,
        ))
        if conv.title == "新对话" and message:
            conv.title = message[:40]
        await db.commit()

        yield f"data: {json.dumps({'type': 'done', 'conversationId': str(conv.id)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
