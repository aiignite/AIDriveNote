"""Keyword-based skill routing for note pages."""
from __future__ import annotations

from dataclasses import dataclass

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
}

BUILTIN_NEGATIVE_KEYWORDS: dict[str, list[str]] = {
    "note_continue": ["导图", "流程图", "思维导图", "drawio"],
    "note_mindmap_expand": ["流程图", "drawio"],
    "note_flowchart_expand": ["思维导图", "导图"],
}


@dataclass
class SkillMatch:
    skill: AISkill
    score: int
    reason: str = ""


class SkillRouter:
    @staticmethod
    def _applicable_types(skill: AISkill) -> list[str] | None:
        extra = skill.extra_config if isinstance(skill.extra_config, dict) else {}
        types = extra.get("applicable_note_types")
        if isinstance(types, list) and types:
            return types
        return BUILTIN_SKILL_NOTE_TYPES.get(skill.code)

    @staticmethod
    def _negative_keywords(skill: AISkill) -> list[str]:
        extra = skill.extra_config if isinstance(skill.extra_config, dict) else {}
        kws = extra.get("negative_keywords")
        if isinstance(kws, list):
            return [str(k) for k in kws if k]
        return BUILTIN_NEGATIVE_KEYWORDS.get(skill.code, [])

    @staticmethod
    async def resolve_for_page(
        db: AsyncSession,
        *,
        page_name: str | None,
        message: str,
        assistant: AIAssistant | None = None,
        page_context: dict | None = None,
    ) -> SkillMatch | None:
        if not page_name:
            return None

        note_type = (page_context or {}).get("noteType")
        selection_text = (page_context or {}).get("selectionText")
        if selection_text and not message.strip():
            message = "行内编辑"

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

        assistant_weights: dict[str, int] = {}
        if assistant:
            ab_res = await db.execute(
                select(AIAssistantSkillBinding)
                .where(
                    AIAssistantSkillBinding.assistant_id == assistant.id,
                    AIAssistantSkillBinding.is_enabled == True,  # noqa: E712
                    AIAssistantSkillBinding.is_deleted == False,  # noqa: E712
                )
            )
            for ab in ab_res.scalars().all():
                assistant_weights[str(ab.skill_id)] = ab.weight

        msg_lower = message.lower()
        best: SkillMatch | None = None

        for binding in bindings:
            skill = binding.skill
            score = binding.weight
            reasons: list[str] = []

            ab_weight = assistant_weights.get(str(skill.id))
            if ab_weight is not None:
                score += ab_weight // 2
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

            if best is None or score > best.score:
                best = SkillMatch(
                    skill=skill,
                    score=score,
                    reason="；".join(reasons) if reasons else "页面默认",
                )

        return best

    @staticmethod
    def merge_tool_names(
        assistant_tools: list[str] | None,
        skill: AISkill | None,
    ) -> list[str]:
        names = list(assistant_tools or [])
        if skill:
            for t in skill.tool_names or []:
                if t not in names:
                    names.append(t)
        return names
