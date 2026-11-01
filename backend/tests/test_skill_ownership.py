"""技能归属隔离：用户命名空间、系统只读与页面绑定覆盖。"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai import AISkill, PageSkillBinding
from app.models.user import User
from app.services.ai_skills.skill_router import SkillRouter


async def _make_user(db: AsyncSession) -> User:
    user = User(
        email=f"skill-{uuid.uuid4().hex}@test.local",
        password_hash="hash",
        name="Skill Tester",
        role="user",
        status="Active",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.asyncio
async def test_same_code_is_allowed_across_users(db_session: AsyncSession):
    a = await _make_user(db_session)
    b = await _make_user(db_session)
    db_session.add_all([
        AISkill(user_id=a.id, code="same_code", name="A", prompt_template="a"),
        AISkill(user_id=b.id, code="same_code", name="B", prompt_template="b"),
    ])
    await db_session.commit()
    assert (await db_session.execute(
        AISkill.__table__.select().where(AISkill.code == "same_code")
    )).all().__len__() == 2


@pytest.mark.asyncio
async def test_forced_code_prefers_user_skill_over_system(db_session: AsyncSession):
    user = await _make_user(db_session)
    system = AISkill(code="shared_code", name="系统", prompt_template="sys")
    mine = AISkill(
        user_id=user.id, code="shared_code", name="我的", prompt_template="mine",
    )
    db_session.add_all([system, mine])
    await db_session.flush()
    db_session.add_all([
        PageSkillBinding(
            user_id=None, page_name="notes", skill_id=system.id, weight=10,
        ),
        PageSkillBinding(
            user_id=user.id, page_name="notes", skill_id=mine.id, weight=90,
        ),
    ])
    await db_session.commit()

    matches = await SkillRouter.resolve_all(
        db_session,
        user_id=user.id,
        page_name="notes",
        message="任意",
        force_codes=["shared_code"],
    )
    assert len(matches) == 1
    assert matches[0].skill.id == mine.id


@pytest.mark.asyncio
async def test_user_page_binding_can_disable_system_skill(db_session: AsyncSession):
    user = await _make_user(db_session)
    skill = AISkill(
        code="note_read_summarize",
        name="总结",
        prompt_template="p",
        keywords=["总结"],
        priority=80,
    )
    db_session.add(skill)
    await db_session.flush()
    db_session.add_all([
        PageSkillBinding(
            user_id=None, page_name="notes", skill_id=skill.id, weight=80,
        ),
        PageSkillBinding(
            user_id=user.id, page_name="notes", skill_id=skill.id,
            weight=80, is_enabled=False,
        ),
    ])
    await db_session.commit()

    matches = await SkillRouter.resolve_all(
        db_session,
        user_id=user.id,
        page_name="notes",
        message="请总结",
    )
    assert matches == []
