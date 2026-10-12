"""AI chat service with assistants, skills, tools, and conversation persistence."""
from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
from app.database import AsyncSessionLocal
from app.models.ai import AIAssistant, AIConversation, AIMessage
from app.services.ai.attachment_service import AttachmentService
from app.services.ai.llm_router import LLMRouter, NoAvailableModelError, ProviderResolution
from app.services.ai.ownership import assistants_visible_to
from app.services.ai.rag_service import RagService
from app.services.ai.tool_executor import ToolExecutor
from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.factory import AIProviderFactory
from app.services.ai_skills.skill_router import SkillRouter

logger = logging.getLogger(__name__)
MAX_TOOL_ROUNDS = 5

# 会话工厂：流式阶段用它按需开启短事务，避免长时间占用连接池中的长连接。
# 由 platform.chat_stream 在启动时注入（便于测试替换）。
session_factory: Callable[[], AsyncSession] = AsyncSessionLocal


def _build_page_context_prompt(page_context: dict[str, Any] | None) -> str:
    if not page_context:
        return ""
    parts = []
    if page_context.get("noteType"):
        parts.append(f"当前笔记类型: {page_context['noteType']}")
    if page_context.get("contextHint"):
        parts.append(str(page_context["contextHint"]))
    if page_context.get("selectedEntities"):
        parts.append(f"选中实体：{json.dumps(page_context['selectedEntities'], ensure_ascii=False)}")
    if page_context.get("selectionText"):
        parts.append(f"编辑器选区：\n```\n{page_context['selectionText']}\n```")
    return "\n".join(parts)


class AIService:
    @staticmethod
    async def get_assistant(
        db: AsyncSession,
        name: str | None,
        *,
        user_id: uuid.UUID | None = None,
        is_guest: bool = False,
    ) -> AIAssistant | None:
        """按名称解析助手。

        传入 ``user_id`` 时按归属过滤（系统助手 + 本人创建）；匿名用户仅可见本人创建的。
        """
        target = name or "笔记助手"
        stmt = select(AIAssistant).where(
            AIAssistant.name == target,
            AIAssistant.is_deleted == False,  # noqa: E712
        )
        if user_id is not None:
            stmt = assistants_visible_to(user_id, is_guest=is_guest)
            stmt = stmt.where(
                AIAssistant.name == target,
                AIAssistant.is_deleted == False,  # noqa: E712
            )
        result = await db.execute(stmt)
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
        messages: list[ChatMessage] = []
        for m in result.scalars().all():
            if m.role in {"user", "system"}:
                messages.append(ChatMessage(role=m.role, content=m.content or ""))
                continue
            if m.role != "assistant":
                continue

            tool_calls = [tc for tc in (m.tool_calls or []) if isinstance(tc, dict)]
            tool_results = [tr for tr in (m.tool_results or []) if isinstance(tr, dict)]

            if tool_calls and tool_results:
                for i, tc in enumerate(tool_calls):
                    messages.append(ChatMessage(
                        role="assistant",
                        content="",
                        tool_calls=[tc],
                    ))
                    if i < len(tool_results):
                        tr = tool_results[i]
                        tc_id = tr.get("tool_call_id") or tc.get("id")
                        messages.append(ChatMessage(
                            role="tool",
                            content=json.dumps(tr.get("result") or {}, ensure_ascii=False),
                            tool_call_id=tc_id,
                        ))
                if m.content and m.content.strip():
                    messages.append(ChatMessage(role="assistant", content=m.content))
            elif tool_calls:
                messages.append(ChatMessage(role="assistant", content="", tool_calls=tool_calls))
            else:
                messages.append(ChatMessage(role="assistant", content=m.content or ""))
        return messages

    @staticmethod
    async def prepare_chat(
        db: AsyncSession,
        user_id: uuid.UUID,
        message: str,
        *,
        assistant_name: str | None = None,
        conversation_id: uuid.UUID | None = None,
        page_context: dict[str, Any] | None = None,
        model_id: str | None = None,
        attachment_ids: list[str] | None = None,
        force_skills: list[str] | None = None,
        is_guest: bool = False,
    ) -> "PreparedChat":
        """流开始前的准备阶段——所有准备工作都在**短事务**内完成并提交。

        这里集中做：解析助手 / 模型 / 会话、技能路由、RAG 上下文、历史消息、
        附件抽取，并落库 user 消息。返回后调用方即可释放连接，交给流式阶段。

        助手与模型的解析都限定在当前用户可见范围内；匿名用户仅能使用自己创建的。
        """
        assistant = await AIService.get_assistant(
            db, assistant_name, user_id=user_id, is_guest=is_guest,
        )
        if not assistant:
            raise ChatPreparationError("未找到助手")

        try:
            resolution = await LLMRouter.resolve(
                db, user_id,
                assistant_model=assistant.model,
                request_model=model_id,
                temperature=assistant.temperature,
                is_guest=is_guest,
            )
        except NoAvailableModelError as exc:
            raise ChatPreparationError(str(exc)) from exc
        conv = await AIService.get_or_create_conversation(
            db, user_id,
            conversation_id=conversation_id,
            assistant_name=assistant.name,
            model_name=resolution.model_name,
        )

        skill_matches = await SkillRouter.resolve_all(
            db,
            page_name=(page_context or {}).get("pageName"),
            message=message,
            assistant=assistant,
            page_context=page_context,
            force_codes=force_skills,
        )

        system_parts = [assistant.system_prompt]
        for m in skill_matches:
            system_parts.append(f"## 激活技能：{m.skill.name}\n{m.skill.prompt_template}")
        page_hint = _build_page_context_prompt(page_context)
        if page_hint:
            system_parts.append(f"## 页面上下文\n{page_hint}")
        rag = await RagService.build_context(db, user_id, message, top_k=5, page_context=page_context)
        if rag:
            system_parts.append(rag)

        history = await AIService.load_history(db, conv.id)

        normalized_attachment_ids = [
            str(aid).strip() for aid in (attachment_ids or []) if str(aid).strip()
        ]
        attachment_names = await AttachmentService.resolve_names(
            db, user_id, normalized_attachment_ids,
        )
        stored_message = AttachmentService.append_attachment_markers(message, attachment_names)

        image_ids, document_ids = await AttachmentService.partition_ids(
            db, user_id, normalized_attachment_ids,
        )
        att_map = await AttachmentService.fetch_map(db, user_id, normalized_attachment_ids)
        user_content: str | list[dict[str, Any]] = message
        if document_ids:
            doc_entries = [
                (aid, att_map[aid].original_name)
                for aid in document_ids
                if aid in att_map
            ]
            extracted = await AttachmentService.extract_documents_text(
                db, user_id, document_ids,
            )
            if isinstance(user_content, str):
                if extracted.strip():
                    user_content += AttachmentService.build_document_hint(doc_entries)
                    user_content += f"\n\n# 附件正文\n\n{extracted}"
                else:
                    user_content += AttachmentService.build_document_hint(
                        doc_entries,
                        extraction_failed=True,
                    )

        vision_images_loaded = False
        image_parts: list[dict[str, Any]] = []
        if image_ids and resolution.supports_image:
            image_parts, loaded_image_ids = await AttachmentService.load_images(
                db, user_id, image_ids,
            )
            vision_images_loaded = bool(image_parts)
            if not loaded_image_ids:
                image_parts = []

        tool_names = SkillRouter.merge_tool_names(assistant.tools, [m.skill for m in skill_matches])
        tool_defs = ToolRegistry.get_tools_for_names(tool_names)
        # 视觉图片与 function calling 同时存在时，MiniMax 等模型容易忽略图片；优先保证识图。
        use_tools = bool(tool_defs) and not vision_images_loaded
        openai_tools = [
            {"type": "function", "function": t.get("function", t)} for t in tool_defs
        ] if use_tools else []

        # 落库 user 消息后立即提交，让调用方可以立刻释放连接
        db.add(AIMessage(
            conversation_id=conv.id,
            role="user",
            content=stored_message,
            attachment_ids=normalized_attachment_ids,
        ))
        await db.commit()

        return PreparedChat(
            user_id=user_id,
            conversation_id=conv.id,
            assistant=assistant,
            resolution=resolution,
            skill_matches=skill_matches,
            openai_tools=openai_tools,
            tool_names=tool_names,
            messages=_assemble_messages(
                system_parts, history, user_content, message,
                image_ids, att_map, resolution.supports_image,
                image_parts, vision_images_loaded,
            ),
            normalized_attachment_ids=normalized_attachment_ids,
            image_ids=[str(aid) for aid in image_ids],
            vision_images_loaded=vision_images_loaded,
        )

    @staticmethod
    async def stream_chat(prepared: "PreparedChat", message: str) -> AsyncIterator[str]:
        """流式阶段：LLM 网络等待期间**不持有**任何 DB 连接。

        每当需要读写数据库（工具执行、落库 assistant 消息）时，用
        ``session_factory`` 开一个短事务，用完立即关闭。
        """
        resolution = prepared.resolution
        assistant = prepared.assistant

        if prepared.skill_matches:
            # 兼容旧前端：仍下发首个技能的 skill_match 事件
            primary = prepared.skill_matches[0]
            yield f"data: {json.dumps({'type': 'skill_match', 'skillName': primary.skill.name, 'reason': primary.reason}, ensure_ascii=False)}\n\n"
            # 新前端主用事件：多技能激活 + 结构化原因
            yield f"data: {json.dumps({'type': 'skill_activated', 'skills': [{'name': m.skill.name, 'code': m.skill.code, 'description': m.skill.description or '', 'score': m.score, 'reasons': m.reasons} for m in prepared.skill_matches]}, ensure_ascii=False)}\n\n"

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
            max_tokens=assistant.max_tokens,
            tools=prepared.openai_tools or None,
            base_url=resolution.endpoint,
            api_key=resolution.api_key,
        )

        full_content = ""
        all_tool_results: list[dict[str, Any]] = []
        all_tool_calls: list[dict[str, Any]] = []
        working_messages = list(prepared.messages)

        for _round in range(MAX_TOOL_ROUNDS):
            round_content = ""
            round_tool_calls: list[dict[str, Any]] = []

            async for chunk in provider.stream_chat_with_tools(working_messages, options):
                if chunk.get("type") == "content":
                    text = chunk.get("content") or ""
                    round_content += text
                    full_content += text
                    yield f"data: {json.dumps({'type': 'content', 'content': text}, ensure_ascii=False)}\n\n"
                elif chunk.get("type") == "thinking":
                    # 推理型模型（如部分 DeepSeek / QwQ）会给出思考过程，转发给前端折叠展示
                    think_text = chunk.get("content") or ""
                    if think_text:
                        yield f"data: {json.dumps({'type': 'thinking', 'content': think_text}, ensure_ascii=False)}\n\n"
                elif chunk.get("type") == "tool_call":
                    round_tool_calls.append(chunk.get("tool_call"))

            if not round_tool_calls:
                break

            all_tool_calls.extend(round_tool_calls)
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
                # 工具开始执行：前端据此展示 running 态
                yield f"data: {json.dumps({'type': 'tool_execution_start', 'tool': name}, ensure_ascii=False)}\n\n"
                # 工具执行需要 DB：每次工具调用开一个短事务，执行完立即释放
                async with session_factory() as tool_db:
                    executor = ToolExecutor(tool_db, prepared.user_id)
                    result = await executor.execute(name, args)
                    await tool_db.commit()
                all_tool_results.append({
                    "tool": name,
                    "tool_call_id": tc.get("id"),
                    "result": result,
                })
                yield f"data: {json.dumps({'type': 'tool_result', 'tool': name, 'result': result}, ensure_ascii=False)}\n\n"
                working_messages.append(ChatMessage(
                    role="tool",
                    content=json.dumps(result, ensure_ascii=False),
                    tool_call_id=tc.get("id"),
                ))

        if not full_content.strip():
            if prepared.vision_images_loaded:
                full_content = "抱歉，未能从模型获得图片分析结果，请重试。"
            elif prepared.image_ids and not resolution.supports_image:
                full_content = (
                    "当前模型不支持图片理解。请在侧栏选择支持图片的模型（如 Minimax），"
                    "或在「设置 → AI 模型」中为对应模型开启「支持图片」。"
                )
            elif prepared.normalized_attachment_ids:
                full_content = "抱歉，模型未返回有效回复，请重试。"
            if full_content:
                yield f"data: {json.dumps({'type': 'content', 'content': full_content}, ensure_ascii=False)}\n\n"

        # 落库 assistant 消息：又一个短事务
        async with session_factory() as save_db:
            save_db.add(AIMessage(
                conversation_id=prepared.conversation_id,
                role="assistant",
                content=full_content,
                tool_calls=all_tool_calls or None,
                tool_results=all_tool_results,
            ))
            await save_db.commit()

        yield f"data: {json.dumps({'type': 'done', 'conversationId': str(prepared.conversation_id)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

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
        attachment_ids: list[str] | None = None,
        force_skills: list[str] | None = None,
    ) -> AsyncIterator[str]:
        """兼容入口：准备 + 流式合流。

        保留此方法是为了不破坏既有调用方与测试；内部走 prepare_chat /
        stream_chat，因此 **LLM 流式阶段不再持有 db 连接**。新代码建议直接
        调用 prepare_chat + stream_chat，由路由在响应返回前释放 db。
        """
        try:
            prepared = await AIService.prepare_chat(
                db, user_id, message,
                assistant_name=assistant_name,
                conversation_id=conversation_id,
                page_context=page_context,
                model_id=model_id,
                attachment_ids=attachment_ids,
                force_skills=force_skills,
            )
        except ChatPreparationError as exc:
            yield f"data: {json.dumps({'type': 'error', 'content': str(exc)}, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
            return

        async for chunk in AIService.stream_chat(prepared, message):
            yield chunk


class ChatPreparationError(Exception):
    """流开始前的准备阶段失败（助手缺失等），可直接作为 SSE 错误事件回传。"""


@dataclass
class PreparedChat:
    """``prepare_chat`` 的产物：流式阶段所需的全部状态。

    这些对象都已脱离 session 生命周期，可安全地在流式阶段长时间持有。
    """

    user_id: uuid.UUID
    conversation_id: uuid.UUID
    assistant: AIAssistant
    resolution: ProviderResolution
    skill_matches: list[Any]
    openai_tools: list[dict[str, Any]]
    tool_names: list[str]
    messages: list[ChatMessage]
    normalized_attachment_ids: list[str]
    image_ids: list[str]
    vision_images_loaded: bool


def _assemble_messages(
    system_parts: list[str],
    history: list[ChatMessage],
    user_content: str | list[dict[str, Any]],
    raw_message: str,
    image_ids: list[str],
    att_map: dict[str, Any],
    supports_image: bool,
    image_parts: list[dict[str, Any]],
    vision_images_loaded: bool,
) -> list[ChatMessage]:
    """拼装送入模型的消息列表（system + 历史 + 本轮 user）。

    纯函数，便于独立测试；图片以多模态 content 注入，不支持图片的模型退化为
    文本提示。
    """
    if image_ids and supports_image:
        system_parts = system_parts + [
            "## 图片理解\n"
            "用户消息中已包含可直接查看的图片，请基于你看到的图片内容回答。"
            "不要声称无法读取图片。"
        ]

    messages = [ChatMessage(role="system", content="\n\n".join(system_parts))]
    messages.extend(history)

    last = ChatMessage(role="user", content=user_content)
    if image_ids and supports_image:
        prompt_text = last.content if isinstance(last.content, str) else ""
        if not str(prompt_text).strip():
            prompt_text = "请描述并分析我上传的图片内容。"
        content_list: list[dict[str, Any]] = [{"type": "text", "text": prompt_text}]
        if image_parts:
            content_list.extend(image_parts)
        else:
            content_list.append({
                "type": "text",
                "text": "\n\n[系统提示：图片附件加载失败，请稍后重试或重新上传。]",
            })
        last.content = content_list
    elif image_ids:
        image_names = [att_map[aid].original_name for aid in image_ids if aid in att_map]
        image_hint = "\n".join(f"📎 {name}" for name in image_names)
        if isinstance(last.content, str) and image_hint:
            last.content = f"{last.content}\n\n{image_hint}".strip()

    messages.append(last)
    return messages
