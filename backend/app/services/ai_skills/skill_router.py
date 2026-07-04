"""Keyword-based skill routing for note pages."""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.ai import AIAssistant, AISkill, PageSkillBinding


@dataclass
class SkillMatch:
    skill: AISkill
    score: int


class SkillRouter:
    @staticmethod
    async def resolve_for_page(
        db: AsyncSession,
        *,
        page_name: str | None,
        message: str,
        assistant: AIAssistant | None = None,
    ) -> SkillMatch | None:
        if not page_name:
            return None
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
        bindings = result.scalars().all()
        msg_lower = message.lower()
        best: SkillMatch | None = None
        for binding in bindings:
            skill = binding.skill
            score = binding.weight
            for kw in skill.keywords or []:
                if kw and kw.lower() in msg_lower:
                    score += 30
            if best is None or score > best.score:
                best = SkillMatch(skill=skill, score=score)
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
