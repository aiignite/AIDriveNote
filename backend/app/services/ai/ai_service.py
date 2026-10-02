"""AI chat service with assistants, skills, tools, and conversation persistence."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncIterator

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
from app.models.ai import AIAssistant, AIConversation, AIMessage
from app.services.ai.attachment_service import AttachmentService
from app.services.ai.llm_router import LLMRouter
from app.services.ai.rag_service import RagService
from app.services.ai.tool_executor import ToolExecutor
from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.factory import AIProviderFactory
from app.services.ai_skills.skill_router import SkillRouter

logger = logging.getLogger(__name__)
MAX_TOOL_ROUNDS = 5


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

        skill_matches = await SkillRouter.resolve_all(
            db,
            page_name=(page_context or {}).get("pageName"),
            message=message,
            assistant=assistant,
            page_context=page_context,
            force_codes=force_skills,
        )
        primary_skill = skill_matches[0] if skill_matches else None
        if primary_skill:
            # 兼容旧前端：仍下发首个技能的 skill_match 事件
            yield f"data: {json.dumps({'type': 'skill_match', 'skillName': primary_skill.skill.name, 'reason': primary_skill.reason}, ensure_ascii=False)}\n\n"
        if skill_matches:
            # 新前端主用事件：多技能激活 + 结构化原因
            yield f"data: {json.dumps({'type': 'skill_activated', 'skills': [{'name': m.skill.name, 'code': m.skill.code, 'description': m.skill.description or '', 'score': m.score, 'reasons': m.reasons} for m in skill_matches]}, ensure_ascii=False)}\n\n"

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

        if image_ids and resolution.supports_image:
            system_parts.append(
                "## 图片理解\n"
                "用户消息中已包含可直接查看的图片，请基于你看到的图片内容回答。"
                "不要声称无法读取图片。"
            )

        messages = [ChatMessage(role="system", content="\n\n".join(system_parts))]
        messages.extend(history)
        messages.append(ChatMessage(role="user", content=user_content))

        vision_images_loaded = False
        if image_ids and resolution.supports_image:
            image_parts, loaded_image_ids = await AttachmentService.load_images(
                db, user_id, image_ids,
            )
            last_msg = messages[-1]
            if last_msg.role == "user":
                prompt_text = (
                    last_msg.content
                    if isinstance(last_msg.content, str)
                    else "请描述并分析我上传的图片内容。"
                )
                if not str(prompt_text).strip():
                    prompt_text = "请描述并分析我上传的图片内容。"
                content_list: list[dict[str, Any]] = [{"type": "text", "text": prompt_text}]
                if image_parts:
                    content_list.extend(image_parts)
                    vision_images_loaded = True
                elif not loaded_image_ids:
                    content_list.append({
                        "type": "text",
                        "text": "\n\n[系统提示：图片附件加载失败，请稍后重试或重新上传。]",
                    })
                last_msg.content = content_list
        elif image_ids:
            image_names = [att_map[aid].original_name for aid in image_ids if aid in att_map]
            image_hint = "\n".join(f"📎 {name}" for name in image_names)
            last_msg = messages[-1]
            if isinstance(last_msg.content, str) and image_hint:
                last_msg.content = f"{last_msg.content}\n\n{image_hint}".strip()

        db.add(AIMessage(
            conversation_id=conv.id,
            role="user",
            content=stored_message,
            attachment_ids=normalized_attachment_ids,
        ))
        await db.flush()
        await db.commit()

        tool_names = SkillRouter.merge_tool_names(assistant.tools, [m.skill for m in skill_matches])
        executor = ToolExecutor(db, user_id)
        tool_defs = executor.get_tools_for_assistant(tool_names)
        # 视觉图片与 function calling 同时存在时，MiniMax 等模型容易忽略图片；优先保证识图。
        use_tools = bool(tool_defs) and not vision_images_loaded
        openai_tools = [
            {"type": "function", "function": t.get("function", t)} for t in tool_defs
        ] if use_tools else []

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
            tools=openai_tools or None,
            base_url=resolution.endpoint,
            api_key=resolution.api_key,
        )

        full_content = ""
        all_tool_results: list[dict[str, Any]] = []
        all_tool_calls: list[dict[str, Any]] = []
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
                result = await executor.execute(name, args)
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
            if vision_images_loaded:
                full_content = "抱歉，未能从模型获得图片分析结果，请重试。"
                yield f"data: {json.dumps({'type': 'content', 'content': full_content}, ensure_ascii=False)}\n\n"
            elif image_ids and not resolution.supports_image:
                full_content = (
                    "当前模型不支持图片理解。请在侧栏选择支持图片的模型（如 Minimax），"
                    "或在「设置 → AI 模型」中为对应模型开启「支持图片」。"
                )
                yield f"data: {json.dumps({'type': 'content', 'content': full_content}, ensure_ascii=False)}\n\n"
            elif normalized_attachment_ids:
                full_content = "抱歉，模型未返回有效回复，请重试。"
                yield f"data: {json.dumps({'type': 'content', 'content': full_content}, ensure_ascii=False)}\n\n"

        db.add(AIMessage(
            conversation_id=conv.id,
            role="assistant",
            content=full_content,
            tool_calls=all_tool_calls or None,
            tool_results=all_tool_results,
        ))
        if conv.title == "新对话" and message:
            conv.title = message[:40]
        await db.commit()

        yield f"data: {json.dumps({'type': 'done', 'conversationId': str(conv.id)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"
