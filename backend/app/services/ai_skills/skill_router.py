"""Keyword-based skill routing for note pages."""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.ai import AIAssistant, AIAssistantSkillBinding, AISkill, PageSkillBinding

# 内置技能默认适用笔记类型（seed 同步到 extra_config）
BUILTIN_SKILL_NOTE_TYPES: dict[str, list[str] | None] = {
    "note_read_summarize": None,
    "note_continue": ["markdown", "rich_text"],
    "note_optimize": ["markdown", "rich_text", "mindmap", "flowchart"],
    "note_create": None,
    "note_mindmap_expand": ["mindmap"],
    "note_flowchart_expand": ["flowchart"],
    "note_inline_edit": ["markdown", "rich_text"],
    # 新增：思维导图 / 流程图“规范设计”类技能
    "mindmap_arch_design": ["mindmap"],
    "flowchart_design": ["flowchart"],
    "mindmap_from_text": ["mindmap"],
    "flowchart_from_text": ["flowchart"],
}

# 内置技能负向关键词（命中即扣分，用于避免导图/流程图类技能互相误命中）
BUILTIN_NEGATIVE_KEYWORDS: dict[str, list[str]] = {
    "note_continue": ["导图", "流程图", "思维导图", "drawio"],
    "note_mindmap_expand": ["流程图", "drawio"],
    "note_flowchart_expand": ["思维导图", "导图"],
    # 设计类技能互相排斥，避免“流程”类请求命中导图技能，反之亦然
    "mindmap_arch_design": ["流程图", "drawio", "泳道"],
    "flowchart_design": ["思维导图", "脑图"],
    "mindmap_from_text": ["流程图", "drawio", "泳道"],
    "flowchart_from_text": ["思维导图", "脑图"],
}


@dataclass
class SkillMatch:
    """技能匹配结果。

    Attributes:
        skill: 命中的技能实体。
        score: 综合打分（含页面权重、助手权重、类型匹配、关键词等）。
        reason: 兼容旧前端的合并原因字符串（中文分号连接）。
        reasons: 结构化原因列表，便于前端标签化展示。
    """

    skill: AISkill
    score: int
    reason: str = ""
    reasons: list[str] = field(default_factory=list)


class SkillRouter:
    @staticmethod
    def _applicable_types(skill: AISkill) -> list[str] | None:
        """获取技能适用的笔记类型（优先取 extra_config，回退内置表）。"""
        extra = skill.extra_config if isinstance(skill.extra_config, dict) else {}
        types = extra.get("applicable_note_types")
        if isinstance(types, list) and types:
            return types
        return BUILTIN_SKILL_NOTE_TYPES.get(skill.code)

    @staticmethod
    def _negative_keywords(skill: AISkill) -> list[str]:
        """获取技能的负向关键词（优先取 extra_config，回退内置表）。"""
        extra = skill.extra_config if isinstance(skill.extra_config, dict) else {}
        kws = extra.get("negative_keywords")
        if isinstance(kws, list):
            return [str(k) for k in kws if k]
        return BUILTIN_NEGATIVE_KEYWORDS.get(skill.code, [])

    @staticmethod
    def _score_skill(
        skill: AISkill,
        binding_weight: int,
        msg_lower: str,
        note_type: str | None,
        selection_text: str | None,
        assistant_weight: int | None,
    ) -> tuple[int, list[str]]:
        """对单个技能打分，返回 (分数, 命中原因列表)。

        Args:
            skill: 待打分技能。
            binding_weight: 页面技能绑定权重。
            msg_lower: 已小写化的用户消息。
            note_type: 当前笔记类型（可为空）。
            selection_text: 编辑器选区文本（可为空）。
            assistant_weight: 助手对该技能的绑定权重（可为空）。

        Returns:
            (score, reasons)：综合分值与中文命中原因列表。
        """
        score = binding_weight
        reasons: list[str] = []

        if assistant_weight is not None:
            score += assistant_weight // 2
            reasons.append("助手绑定")

        applicable = SkillRouter._applicable_types(skill)
        if note_type and applicable is not None:
            if note_type in applicable:
                score += 40
                reasons.append(f"匹配类型 {note_type}")
            else:
                score -= 50

        for kw in skill.keywords or []:
            if kw and kw.lower() in msg_lower:
                score += 30
                reasons.append(f"关键词「{kw}」")

        for nkw in SkillRouter._negative_keywords(skill):
            if nkw and nkw.lower() in msg_lower:
                score -= 40

        if selection_text and skill.code == "note_inline_edit":
            score += 60
            reasons.append("选区编辑")

        if skill.priority:
            score += skill.priority // 10

        return score, reasons

    @staticmethod
    async def _assistant_weights(
        db: AsyncSession,
        assistant: AIAssistant | None,
    ) -> dict[str, int]:
        """查询助手绑定的技能权重映射（skill_id -> weight）。"""
        weights: dict[str, int] = {}
        if not assistant:
            return weights
        ab_res = await db.execute(
            select(AIAssistantSkillBinding).where(
                AIAssistantSkillBinding.assistant_id == assistant.id,
                AIAssistantSkillBinding.is_enabled == True,  # noqa: E712
                AIAssistantSkillBinding.is_deleted == False,  # noqa: E712
            )
        )
        for ab in ab_res.scalars().all():
            weights[str(ab.skill_id)] = ab.weight
        return weights

    @staticmethod
    async def resolve_all(
        db: AsyncSession,
        *,
        page_name: str | None,
        message: str,
        assistant: AIAssistant | None = None,
        page_context: dict | None = None,
        force_codes: list[str] | None = None,
        limit: int = 3,
    ) -> list[SkillMatch]:
        """解析本次对话需要激活的技能列表（支持手动固定多技能）。

        Args:
            db: 数据库会话。
            page_name: 当前页面名（如 notes）。
            message: 用户消息。
            assistant: 当前助手（用于助手绑定加权）。
            page_context: 页面上下文（noteType / selectionText 等）。
            force_codes: 手动固定的技能 code 列表；非空时跳过自动打分直接命中。
            limit: 自动匹配时返回的最大技能数量。

        Returns:
            按分数降序的技能匹配列表；无命中返回空列表。
        """
        note_type = (page_context or {}).get("noteType")
        selection_text = (page_context or {}).get("selectionText")
        if selection_text and not message.strip():
            message = "行内编辑"

        assistant_weights = await SkillRouter._assistant_weights(db, assistant)

        # 手动固定技能：所见即所得，按 code 直接返回，不参与打分
        forced_codes = [str(c).strip() for c in (force_codes or []) if str(c).strip()]
        if forced_codes:
            res = await db.execute(
                select(AISkill).where(
                    AISkill.code.in_(forced_codes),
                    AISkill.is_enabled == True,  # noqa: E712
                    AISkill.is_deleted == False,  # noqa: E712
                )
            )
            by_code = {s.code: s for s in res.scalars().all()}
            matches: list[SkillMatch] = []
            for code in forced_codes:
                skill = by_code.get(code)
                if not skill:
                    continue
                matches.append(SkillMatch(
                    skill=skill,
                    score=skill.priority or 0,
                    reason="手动固定",
                    reasons=["手动固定"],
                ))
            return matches[:limit] if limit else matches

        if not page_name:
            return []

        result = await db.execute(
            select(PageSkillBinding)
            .join(AISkill)
            .where(
                PageSkillBinding.page_name == page_name,
                PageSkillBinding.is_enabled == True,  # noqa: E712
                PageSkillBinding.is_deleted == False,  # noqa: E712
                AISkill.is_enabled == True,  # noqa: E712
                AISkill.is_deleted == False,  # noqa: E712
            )
            .options(selectinload(PageSkillBinding.skill))
        )
        bindings = list(result.scalars().all())

        msg_lower = message.lower()
        matches = []
        for binding in bindings:
            skill = binding.skill
            score, reasons = SkillRouter._score_skill(
                skill,
                binding.weight,
                msg_lower,
                note_type,
                selection_text,
                assistant_weights.get(str(skill.id)),
            )
            matches.append(SkillMatch(
                skill=skill,
                score=score,
                reason="；".join(reasons) if reasons else "页面默认",
                reasons=reasons or ["页面默认"],
            ))

        matches.sort(key=lambda m: m.score, reverse=True)
        positive = [m for m in matches if m.score > 0]
        return positive[:limit] if limit else positive

    @staticmethod
    async def resolve_for_page(
        db: AsyncSession,
        *,
        page_name: str | None,
        message: str,
        assistant: AIAssistant | None = None,
        page_context: dict | None = None,
    ) -> SkillMatch | None:
        """兼容包装：返回单个最优技能（内部复用 resolve_all）。"""
        matches = await SkillRouter.resolve_all(
            db,
            page_name=page_name,
            message=message,
            assistant=assistant,
            page_context=page_context,
            limit=1,
        )
        return matches[0] if matches else None

    @staticmethod
    def merge_tool_names(
        assistant_tools: list[str] | None,
        skills: list[AISkill] | None,
    ) -> list[str]:
        """合并助手工具与多个技能的工具名（去重保序）。

        Args:
            assistant_tools: 助手默认工具名列表。
            skills: 本次激活的技能列表（可为空）。

        Returns:
            去重后的工具名列表。
        """
        names = list(assistant_tools or [])
        for skill in skills or []:
            for t in skill.tool_names or []:
                if t not in names:
                    names.append(t)
        return names