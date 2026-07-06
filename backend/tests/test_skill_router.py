"""Tests for skill router note-type weighting."""
from __future__ import annotations

import pytest

from app.models.ai import AIAssistant, AISkill, PageSkillBinding
from app.services.ai_skills.skill_router import SkillRouter


@pytest.mark.asyncio
async def test_skill_router_prefers_mindmap_skill(db_session):
    skill_m = AISkill(
        code="note_mindmap_expand",
        name="扩展导图",
        keywords=["扩展"],
        prompt_template="mindmap",
        tool_names=["get_note"],
        priority=75,
        extra_config={"applicable_note_types": ["mindmap"]},
    )
    skill_c = AISkill(
        code="note_continue",
        name="续写",
        keywords=["续写"],
        prompt_template="continue",
        tool_names=["append_to_note"],
        priority=90,
        extra_config={"applicable_note_types": ["markdown", "rich_text"]},
    )
    db_session.add_all([skill_m, skill_c])
    await db_session.flush()

    db_session.add(PageSkillBinding(page_name="notes", skill_id=skill_m.id, weight=50))
    db_session.add(PageSkillBinding(page_name="notes", skill_id=skill_c.id, weight=50))
    await db_session.commit()

    match = await SkillRouter.resolve_for_page(
        db_session,
        page_name="notes",
        message="请扩展节点",
        page_context={"noteType": "mindmap"},
    )
    assert match is not None
    assert match.skill.code == "note_mindmap_expand"
