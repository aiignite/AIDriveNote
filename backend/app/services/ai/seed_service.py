"""Seed default AI models, note assistant, and builtin skills."""
from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
import app.ai_tools  # noqa: F401
from app.config import get_settings
from app.models.ai import (
    AIAssistant,
    AIAssistantSkillBinding,
    AIModel,
    AISkill,
    PageSkillBinding,
)

NOTE_ASSISTANT_PROMPT = """你是 AIDriveNote 笔记助手，帮助用户管理各种类型的笔记内容。

## 可用工具
- list_notes — 查询笔记列表
- get_note — 获取笔记详情（含完整内容）
- create_note — 创建新笔记
- update_note — 更新笔记（content 变更生成预览，需用户确认）
- append_to_note — 末尾追加内容（需用户确认）
- delete_note — 删除笔记
- list_note_folders / move_note_to_folder — 文件夹管理
- list_note_templates / create_note_from_template — 模板
- list_note_tags / add_tags_to_note — 标签

## 内容变更确认（重要）
update_note 和 append_to_note 不会立即写入，需用户在对话框确认后才应用。

## 内容格式
- markdown: {"text": "..."} 或 Markdown 字符串
- rich_text: {"blocks": [...]} BlockNote 结构
- mindmap: simple-mind-map JSON 树
- flowchart: {"xml": "..."}

## 交互规则
1. 页面上下文含当前笔记 ID 时直接使用
2. 续写/扩写 → append_to_note
3. 总结/优化 → get_note 后 update_note
4. 创建前先确认笔记类型
"""

BUILTIN_SKILLS = [
    {
        "code": "note_read_summarize",
        "name": "读取并总结",
        "keywords": ["总结", "概括", "摘要", "归纳"],
        "prompt_template": "用户希望总结笔记。先 get_note 获取内容，再给出简洁中文摘要，不要修改原文。",
        "tool_names": ["get_note"],
        "priority": 80,
    },
    {
        "code": "note_continue",
        "name": "续写",
        "keywords": ["续写", "扩写", "继续写", "补充"],
        "prompt_template": "用户希望续写笔记。先 get_note 了解已有内容，再用 append_to_note 追加；告知用户需在卡片确认。",
        "tool_names": ["get_note", "append_to_note"],
        "priority": 90,
    },
    {
        "code": "note_optimize",
        "name": "优化润色",
        "keywords": ["优化", "润色", "改进", "改写"],
        "prompt_template": "用户希望优化笔记。先 get_note，再用 update_note 提供优化后的完整内容预览。",
        "tool_names": ["get_note", "update_note"],
        "priority": 85,
    },
    {
        "code": "note_create",
        "name": "创建笔记",
        "keywords": ["新建", "创建", "写一条"],
        "prompt_template": "用户希望创建笔记。确认 note_type 后使用 create_note。",
        "tool_names": ["create_note"],
        "priority": 70,
    },
    {
        "code": "note_mindmap_expand",
        "name": "扩展导图",
        "keywords": ["扩展导图", "补充节点", "思维导图"],
        "prompt_template": "用户希望扩展思维导图。get_note 后 update_note 提交新导图结构预览。",
        "tool_names": ["get_note", "update_note"],
        "priority": 75,
    },
]


class AISeedService:
    @staticmethod
    async def ensure_platform_seed(db: AsyncSession) -> None:
        settings = get_settings()
        model_name = f"Ollama/{settings.OLLAMA_MODEL}"

        result = await db.execute(
            select(AIModel).where(AIModel.name == model_name, AIModel.is_deleted == False)  # noqa: E712
        )
        ai_model = result.scalar_one_or_none()
        if not ai_model:
            ai_model = AIModel(
                id=uuid.uuid4(),
                name=model_name,
                model_id=settings.OLLAMA_MODEL,
                provider="OLLAMA",
                endpoint=settings.OLLAMA_BASE_URL,
                description="默认本地 Ollama 模型",
                is_public=True,
            )
            db.add(ai_model)
            await db.flush()

        result = await db.execute(
            select(AIAssistant).where(AIAssistant.name == "笔记助手", AIAssistant.is_deleted == False)  # noqa: E712
        )
        assistant = result.scalar_one_or_none()
        note_tools = ToolRegistry.get_tools_by_category("note")
        if assistant:
            # 仅同步工具列表与系统标记，保留用户在 UI 中修改的模型/提示词/参数
            assistant.tools = note_tools
            assistant.is_system = True
            if not assistant.model:
                assistant.model = model_name
            if assistant.temperature is None:
                assistant.temperature = 0.4
            if assistant.max_tokens is None:
                assistant.max_tokens = 16384
            if not assistant.system_prompt:
                assistant.system_prompt = NOTE_ASSISTANT_PROMPT
            if not assistant.description:
                assistant.description = "辅助管理笔记：创建、查询、更新、删除，支持四种笔记类型。"
            if not assistant.avatar:
                assistant.avatar = "📝"
            if not assistant.role:
                assistant.role = "笔记助手"
            if not assistant.category:
                assistant.category = "System"
        else:
            assistant = AIAssistant(
                name="笔记助手",
                description="辅助管理笔记：创建、查询、更新、删除，支持四种笔记类型。",
                avatar="📝",
                role="笔记助手",
                category="System",
                system_prompt=NOTE_ASSISTANT_PROMPT,
                model=model_name,
                temperature=0.4,
                max_tokens=16384,
                is_system=True,
                is_default=True,
                tools=note_tools,
            )
            db.add(assistant)
            await db.flush()

        for item in BUILTIN_SKILLS:
            res = await db.execute(
                select(AISkill).where(AISkill.code == item["code"], AISkill.is_deleted == False)  # noqa: E712
            )
            skill = res.scalar_one_or_none()
            if skill:
                # 已存在的技能保留用户编辑内容，仅确保绑定关系
                pass
            else:
                skill = AISkill(
                    code=item["code"],
                    name=item["name"],
                    keywords=item["keywords"],
                    prompt_template=item["prompt_template"],
                    tool_names=item["tool_names"],
                    priority=item["priority"],
                    is_enabled=True,
                    is_builtin=True,
                )
                db.add(skill)
                await db.flush()

            pb_res = await db.execute(
                select(PageSkillBinding).where(
                    PageSkillBinding.page_name == "notes",
                    PageSkillBinding.skill_id == skill.id,
                    PageSkillBinding.is_deleted == False,  # noqa: E712
                )
            )
            if not pb_res.scalar_one_or_none():
                db.add(PageSkillBinding(page_name="notes", skill_id=skill.id, weight=skill.priority))

            ab_res = await db.execute(
                select(AIAssistantSkillBinding).where(
                    AIAssistantSkillBinding.assistant_id == assistant.id,
                    AIAssistantSkillBinding.skill_id == skill.id,
                    AIAssistantSkillBinding.is_deleted == False,  # noqa: E712
                )
            )
            if not ab_res.scalar_one_or_none():
                db.add(AIAssistantSkillBinding(
                    assistant_id=assistant.id, skill_id=skill.id, weight=skill.priority,
                ))

        await db.commit()
