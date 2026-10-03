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
- get_note — 获取笔记详情（默认摘要，include_full_content=true 获取完整内容）
- create_note — 创建新笔记
- update_note — 更新笔记（content 变更生成预览，需用户确认）
- append_to_note — 末尾追加内容（markdown/rich_text，需用户确认）
- append_to_mindmap — 向思维导图追加子节点（需用户确认）
- delete_note — 删除笔记（需用户确认）
- batch_summarize_notes / batch_add_tags — 批量操作
- list_note_folders / move_note_to_folder — 文件夹管理
- list_note_templates / create_note_from_template — 模板
- list_note_tags / add_tags_to_note — 标签

## 内容变更确认（重要）
update_note 和 append_to_note 不会立即写入，需用户在对话框确认后才应用。

## 内容格式
- markdown: {"text": "..."} 或 Markdown 字符串
- rich_text: {"blocks": [...]} BlockNote 结构
- mindmap: simple-mind-map JSON 树，格式 {"data":{"text":"中心主题"},"children":[{"data":{"text":"分支"},"children":[]}]}
  每个分支必须是独立节点对象，禁止将全部大纲文本塞进单个 data.text
- flowchart: {"xml": "<mxGraphModel>...含 mxCell...</mxGraphModel>"}（draw.io XML，不可用纯文本树）

## 交互规则
1. 页面上下文含当前笔记 ID 时直接使用
2. 续写/扩写 → append_to_note
3. 总结/优化 → get_note 后 update_note
4. 创建前先确认笔记类型
"""

MINDMAP_ASSISTANT_PROMPT = """你是「思维导图设计助手」，擅长把自然语言描述转化为结构清晰、层级分明的思维导图 / 框架图。

## 输出规范（simple-mind-map JSON）
- 根节点为中心主题，其下按逻辑分层展开，建议 3~4 层，每层 3~7 个分支。
- 每个节点必须是独立对象：{"data":{"text":"标签"},"children":[]}
- 标签精炼（建议 ≤20 字），使用名词短语，不要写长句。
- 严禁把整段描述塞进单个 data.text；必须拆分为多节点、多层级。
- 根节点必须含 children，叶子节点 children 为空数组。

## 可用工具
- get_note — 读取当前笔记（include_full_content=true 获取完整结构）
- create_note — 新建思维导图（note_type=mindmap）
- update_note — 覆盖更新已有导图（生成预览，需用户确认）

## 工作方式
1. 若页面上下文含当前笔记 ID，先 get_note 了解现状。
2. 依据用户描述设计结构，通过 create_note/update_note 提交预览，等待用户确认。
3. 用中文简要说明分层思路（3~5 条），不要把 JSON 原文贴给用户。
"""

FLOWCHART_ASSISTANT_PROMPT = """你是「流程图设计助手」，擅长把自然语言描述转化为规范、可直接在 draw.io 编辑的流程图。

## 输出规范（draw.io mxGraphModel XML）
- 内容格式必须为 {"xml": "<mxGraphModel>...</mxGraphModel>"}。
- 每个节点/连线用 mxCell 定义，必含 id、value、style；节点还需子 mxGeometry（x/y/width/height）。
- 连线 mxCell 需含 edge="1"、source、target、parent="1"。
- 节点样式约定：
  - 开始/结束：ellipse;whiteSpace=wrap;html=1;arcSize=50
  - 处理步骤：rounded=1;whiteSpace=wrap;html=1
  - 判断分支：rhombus;whiteSpace=wrap;html=1
  - 连线：edgeStyle=orthogonalEdgeStyle;rounded=0;html=1
- 保持已有 mxCell 的 id 不变；新增节点使用新的唯一 id。
- 严禁用纯文本列表代替 XML。

## 可用工具
- get_note — 读取当前笔记（含现有 XML）
- create_note — 新建流程图（note_type=flowchart）
- update_note — 覆盖更新已有流程图（生成预览，需用户确认）

## 工作方式
1. 先梳理步骤顺序与判断分支，再生成 XML。
2. 通过 create_note/update_note 提交预览，等待用户确认。
3. 用中文简要说明流程节点与分支，不要粘贴 XML 原文。
"""

BUILTIN_SKILLS = [
    {
        "code": "note_read_summarize",
        "name": "读取并总结",
        "keywords": ["总结", "概括", "摘要", "归纳"],
        "prompt_template": "用户希望总结笔记。先 get_note 获取内容（必要时 include_full_content=true），再给出简洁中文摘要，不要修改原文。",
        "tool_names": ["get_note"],
        "priority": 80,
        "extra_config": {"applicable_note_types": None},
    },
    {
        "code": "note_continue",
        "name": "续写",
        "keywords": ["续写", "扩写", "继续写", "补充"],
        "prompt_template": (
            "用户希望续写笔记。仅适用于 markdown/rich_text。"
            "先 get_note(include_full_content=true)，再用 append_to_note 追加；告知用户需在卡片确认。"
        ),
        "tool_names": ["get_note", "append_to_note"],
        "priority": 90,
        "extra_config": {"applicable_note_types": ["markdown", "rich_text"]},
    },
    {
        "code": "note_optimize",
        "name": "优化润色",
        "keywords": ["优化", "润色", "改进", "改写"],
        "prompt_template": (
            "用户希望优化笔记。先 get_note(include_full_content=true)，"
            "再用 update_note 提供优化后的完整内容预览。"
        ),
        "tool_names": ["get_note", "update_note"],
        "priority": 85,
        "extra_config": {"applicable_note_types": ["markdown", "rich_text", "mindmap", "flowchart"]},
    },
    {
        "code": "note_create",
        "name": "创建笔记",
        "keywords": ["新建", "创建", "写一条"],
        "prompt_template": "用户希望创建笔记。确认 note_type 后使用 create_note。",
        "tool_names": ["create_note"],
        "priority": 70,
        "extra_config": {"applicable_note_types": None},
    },
    {
        "code": "note_mindmap_expand",
        "name": "扩展导图",
        "keywords": ["扩展导图", "补充节点", "思维导图", "扩展节点"],
        "prompt_template": (
            "用户希望扩展思维导图。get_note(include_full_content=true) 获取现有结构后，"
            "优先用 append_to_mindmap 追加子节点；大范围改动用 update_note 提交整树预览。\n"
            "要求：nodes 必须为 simple-mind-map JSON，每个节点 {\"data\":{\"text\":\"标签\"},\"children\":[]}；"
            "可传节点数组；多分支须拆成多个 children 节点，"
            "禁止将全部设计内容写入单个 data.text 字符串。"
        ),
        "tool_names": ["get_note", "update_note", "append_to_mindmap"],
        "priority": 75,
        "extra_config": {"applicable_note_types": ["mindmap"]},
    },
    {
        "code": "note_flowchart_expand",
        "name": "扩展流程图",
        "keywords": ["流程图", "补充步骤", "drawio", "扩展流程"],
        "prompt_template": (
            "用户希望扩展流程图。get_note(include_full_content=true) 获取现有 XML 后，"
            "用 update_note 提交完整 draw.io mxGraphModel XML 预览。\n"
            "要求：content 必须为 {\"xml\": \"<mxGraphModel>...</mxGraphModel>\"} 格式，"
            "每个节点/连线用 mxCell 定义（含 id、value、style、mxGeometry）；"
            "保持已有 mxCell id 不变；禁止用纯文本树形结构代替 XML。"
        ),
        "tool_names": ["get_note", "update_note"],
        "priority": 74,
        "extra_config": {"applicable_note_types": ["flowchart"]},
    },
    {
        "code": "note_inline_edit",
        "name": "行内编辑",
        "keywords": ["润色选区", "翻译", "改写选区"],
        "prompt_template": (
            "用户对编辑器选区发起 AI 请求。页面上下文含 selectionText。"
            "根据意图润色/翻译/续写选区，用 update_note 或 append_to_note 提交预览。"
        ),
        "tool_names": ["get_note", "update_note", "append_to_note"],
        "priority": 95,
        "extra_config": {"applicable_note_types": ["markdown", "rich_text"]},
    },
    # ── 新增：思维导图 / 流程图“规范设计”类技能（自然语言 → 规范结构）──
    {
        "code": "mindmap_arch_design",
        "name": "思维导图框架设计",
        "keywords": ["设计导图", "框架图", "脑图设计", "梳理结构", "设计框架", "设计思维导图", "生成思维导图", "设计"],
        "prompt_template": (
            "用户希望依据自然语言描述设计思维导图/框架图。先 get_note(include_full_content=true) 了解现状；"
            "生成规范 simple-mind-map JSON 树，通过 update_note（已有笔记）或 create_note（note_type=mindmap）提交预览。\n"
            "结构要求：中心主题为根，一级/二级分支必须拆分为独立节点 "
            "{\"data\":{\"text\":\"标签\"},\"children\":[]}；层级清晰、标签精炼（≤20 字）；"
            "禁止把整段描述塞进单个 data.text。"
        ),
        "tool_names": ["get_note", "update_note", "create_note"],
        "priority": 81,
        "extra_config": {"applicable_note_types": ["mindmap"]},
        "bind_note_assistant": False,
    },
    {
        "code": "flowchart_design",
        "name": "流程图规范设计",
        "keywords": ["设计流程", "流程设计", "画流程", "画泳道", "画判断", "流程图设计", "设计"],
        "prompt_template": (
            "用户希望依据自然语言描述设计流程图。get_note(include_full_content=true) 获取现状（如有）；"
            "生成规范 draw.io mxGraphModel XML，通过 update_note 或 create_note(note_type=flowchart) 提交预览。\n"
            "节点规范：开始/结束用 ellipse+arcSize=50，处理用 rounded=1，判断用 rhombus；"
            "每个 mxCell 必含 id/value/style，节点含子 mxGeometry（x/y/width/height）；"
            "连线含 edge=1、source、target；保持已有 mxCell id 不变；禁止用纯文本树代替 XML。"
        ),
        "tool_names": ["get_note", "update_note", "create_note"],
        "priority": 80,
        "extra_config": {"applicable_note_types": ["flowchart"]},
        "bind_note_assistant": False,
    },
    {
        "code": "mindmap_from_text",
        "name": "文本转思维导图",
        "keywords": ["转成思维导图", "转成导图", "文本转导图", "大纲转导图", "转思维导图"],
        "prompt_template": (
            "用户希望把一段文本/大纲转换为思维导图。抽取要点，按层级生成 simple-mind-map JSON 树，"
            "用 create_note(note_type=mindmap) 或 update_note 提交预览；多分支必须拆成独立节点。"
        ),
        "tool_names": ["get_note", "create_note", "update_note"],
        "priority": 77,
        "extra_config": {"applicable_note_types": ["mindmap"]},
        "bind_note_assistant": False,
    },
    {
        "code": "flowchart_from_text",
        "name": "文本转流程图",
        "keywords": ["转成流程图", "文本转流程", "大纲转流程", "转流程图"],
        "prompt_template": (
            "用户希望把一段文本/步骤转换为流程图。梳理顺序与分支，生成规范 draw.io mxGraphModel XML，"
            "用 create_note(note_type=flowchart) 或 update_note 提交预览；禁止用纯文本树代替 XML。"
        ),
        "tool_names": ["get_note", "create_note", "update_note"],
        "priority": 76,
        "extra_config": {"applicable_note_types": ["flowchart"]},
        "bind_note_assistant": False,
    },
    # ── 新增：联网查询 / 对话整理成笔记 ──
    {
        "code": "note_web_research",
        "name": "联网查询",
        "keywords": ["联网", "搜索", "搜一下", "查一下", "查一查", "最新", "网上", "检索", "在线查询", "实时"],
        "prompt_template": (
            "用户希望获取互联网上的实时/外部信息。先用 web_search 检索关键词，"
            "拿到 {title,url,snippet} 结果后用中文综合归纳作答，并附上关键来源链接；"
            "不要原样堆砌搜索结果。\n"
            "若用户同时要求留档，再用 create_note 生成一篇 markdown 笔记（含来源链接）；"
            "若联网搜索未启用或请求失败，如实说明原因，并基于已有知识谨慎作答。"
        ),
        "tool_names": ["web_search", "create_note"],
        "priority": 82,
        "extra_config": {
            "applicable_note_types": None,
            # 负向关键词：避免“搜索我的笔记 / 导图”这类本地检索被误判为联网搜索
            "negative_keywords": ["笔记", "导图", "流程图", "drawio"],
        },
    },
    {
        "code": "chat_to_note",
        "name": "整理成笔记",
        "keywords": [
            "整理成笔记", "存为笔记", "保存为文档", "导出为文档", "整理成文档",
            "整理成一篇文章", "整理成文章", "把上面的内容整理", "生成文档", "存到笔记", "记为文档",
        ],
        "prompt_template": (
            "用户希望把当前对话/查询/讨论的内容整理成文档并存入笔记。\n"
            "1. 先梳理对话上下文中的关键结论，组织为结构清晰的 Markdown（一句话标题、分级小标题、"
            "要点列表，涉及外部信息时附来源链接）；\n"
            "2. 用 create_note(note_type=markdown) 创建笔记，标题需概括主题，正文避免口语化冗余；\n"
            "3. 若用户明确要追加到某篇已有笔记，改用 append_to_note 并说明需在卡片确认。"
        ),
        "tool_names": ["create_note", "append_to_note"],
        "priority": 88,
        "extra_config": {"applicable_note_types": None},
    },
]

# 未绑定「笔记助手」、而是绑定到专用设计助手的技能 code 集合
DESIGN_SKILL_CODES = {
    "mindmap_arch_design",
    "flowchart_design",
    "mindmap_from_text",
    "flowchart_from_text",
}

# 专用设计助手定义（技能按 code 关联，绑定到各自助手）
DESIGN_ASSISTANTS = [
    {
        "name": "思维导图设计助手",
        "description": "把自然语言描述转化为结构清晰的思维导图 / 框架图（simple-mind-map JSON）。",
        "avatar": "🧠",
        "role": "思维导图设计助手",
        "system_prompt": MINDMAP_ASSISTANT_PROMPT,
        "skill_codes": ["mindmap_arch_design", "mindmap_from_text", "note_mindmap_expand"],
    },
    {
        "name": "流程图设计助手",
        "description": "把自然语言描述转化为规范、可编辑的 draw.io 流程图（mxGraphModel XML）。",
        "avatar": "🔀",
        "role": "流程图设计助手",
        "system_prompt": FLOWCHART_ASSISTANT_PROMPT,
        "skill_codes": ["flowchart_design", "flowchart_from_text", "note_flowchart_expand"],
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

        skill_by_code: dict[str, AISkill] = {}
        for item in BUILTIN_SKILLS:
            res = await db.execute(
                select(AISkill).where(AISkill.code == item["code"], AISkill.is_deleted == False)  # noqa: E712
            )
            skill = res.scalar_one_or_none()
            if skill:
                if item.get("extra_config") and not (skill.extra_config or {}):
                    skill.extra_config = item["extra_config"]
                if skill.is_builtin and skill.prompt_template != item["prompt_template"]:
                    skill.prompt_template = item["prompt_template"]
            else:
                skill = AISkill(
                    code=item["code"],
                    name=item["name"],
                    keywords=item["keywords"],
                    prompt_template=item["prompt_template"],
                    tool_names=item["tool_names"],
                    priority=item["priority"],
                    extra_config=item.get("extra_config") or {},
                    is_enabled=True,
                    is_builtin=True,
                )
                db.add(skill)
                await db.flush()

            skill_by_code[item["code"]] = skill

            pb_res = await db.execute(
                select(PageSkillBinding).where(
                    PageSkillBinding.page_name == "notes",
                    PageSkillBinding.skill_id == skill.id,
                    PageSkillBinding.is_deleted == False,  # noqa: E712
                )
            )
            if not pb_res.scalar_one_or_none():
                db.add(PageSkillBinding(page_name="notes", skill_id=skill.id, weight=skill.priority))

            # 设计类技能只绑定到专用设计助手，不绑定「笔记助手」，避免误命中
            if item["code"] in DESIGN_SKILL_CODES:
                continue

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

        # 新增：专用设计助手（思维导图 / 流程图），并绑定各自技能
        for spec in DESIGN_ASSISTANTS:
            asst_res = await db.execute(
                select(AIAssistant).where(
                    AIAssistant.name == spec["name"],
                    AIAssistant.is_deleted == False,  # noqa: E712
                )
            )
            design_assistant = asst_res.scalar_one_or_none()
            if design_assistant:
                # 仅补全缺失字段，保留用户在 UI 中的修改
                design_assistant.tools = note_tools
                design_assistant.is_system = True
                if not design_assistant.system_prompt:
                    design_assistant.system_prompt = spec["system_prompt"]
                if not design_assistant.description:
                    design_assistant.description = spec["description"]
                if not design_assistant.avatar:
                    design_assistant.avatar = spec["avatar"]
                if not design_assistant.role:
                    design_assistant.role = spec["role"]
                if not design_assistant.category:
                    design_assistant.category = "Design"
                if not design_assistant.model:
                    design_assistant.model = model_name
                if design_assistant.temperature is None:
                    design_assistant.temperature = 0.3
                if design_assistant.max_tokens is None:
                    design_assistant.max_tokens = 16384
            else:
                design_assistant = AIAssistant(
                    name=spec["name"],
                    description=spec["description"],
                    avatar=spec["avatar"],
                    role=spec["role"],
                    category="Design",
                    system_prompt=spec["system_prompt"],
                    model=model_name,
                    temperature=0.3,
                    max_tokens=16384,
                    is_system=True,
                    is_default=False,
                    tools=note_tools,
                )
                db.add(design_assistant)
                await db.flush()

            for code in spec["skill_codes"]:
                skill = skill_by_code.get(code)
                if not skill:
                    continue
                dab_res = await db.execute(
                    select(AIAssistantSkillBinding).where(
                        AIAssistantSkillBinding.assistant_id == design_assistant.id,
                        AIAssistantSkillBinding.skill_id == skill.id,
                        AIAssistantSkillBinding.is_deleted == False,  # noqa: E712
                    )
                )
                if not dab_res.scalar_one_or_none():
                    db.add(AIAssistantSkillBinding(
                        assistant_id=design_assistant.id,
                        skill_id=skill.id,
                        weight=skill.priority,
                    ))

        await db.commit()
