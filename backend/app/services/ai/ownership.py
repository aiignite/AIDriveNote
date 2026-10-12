"""AI 模型与助手的归属作用域。

**背景**：``ai_models.user_id`` / ``ai_assistants.user_id`` 曾经是「只写不读」字段——
写入时记录了创建者，但所有查询都不按 user_id 过滤，``LLMRouter`` 甚至用
``select(AIModel).where(is_deleted == False).limit(1)`` 兜底，**随机取全库任意一行**。
后果是任何用户（尤其是匿名用户）都会用上陌生人的模型与其付费 API Key，
且任何人都能编辑 / 删除他人的模型。

本模块给出统一的作用域口径，供路由与 ``LLMRouter`` 共用：

- ``user_id IS NULL``：**系统种子数据**（由 ``AISeedService.ensure_platform_seed`` 创建）。
- ``user_id = 当前用户``：该用户自己创建的。
- 其他用户的行：**一律不可见、不可改、不可用**。

匿名账号的额外限制：匿名用户只能使用**自己创建**的模型，不含系统种子模型——
系统种子通常指向管理员配置的 Ollama / 付费 Key，不应对外暴露。
"""
from __future__ import annotations

import uuid

from sqlalchemy import Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai import AIAssistant, AIModel, UserAISettings


def scope_by_owner(stmt: Select, column, user_id: uuid.UUID, *, include_system: bool = True):
    """给查询加上「系统 + 本人」的归属过滤。

    @param column 模型/助手的归属列（``AIModel.user_id`` 等）
    @param user_id 当前用户
    @param include_system 是否包含系统种子数据（``user_id IS NULL``）
    """
    if include_system:
        return stmt.where(or_(column == user_id, column.is_(None)))
    return stmt.where(column == user_id)


def models_visible_to(
    db_user_id: uuid.UUID, *, is_guest: bool = False, include_system: bool = True,
) -> Select:
    """当前用户可见的模型查询（尚未过滤软删除）。"""
    return scope_by_owner(
        select(AIModel), AIModel.user_id, db_user_id,
        include_system=include_system and not is_guest,
    )


def assistants_visible_to(
    db_user_id: uuid.UUID, *, is_guest: bool = False, include_system: bool = True,
) -> Select:
    """当前用户可见的助手查询（尚未过滤软删除）。"""
    return scope_by_owner(
        select(AIAssistant), AIAssistant.user_id, db_user_id,
        include_system=include_system and not is_guest,
    )


def owned_model(
    db_user_id: uuid.UUID, model_id: uuid.UUID, *, is_guest: bool = False,
) -> Select:
    """按 ID 取一个**可写**的模型：本人创建，或系统种子（``user_id IS NULL``）。

    保留改动前的既有能力：系统预置模型与助手是平台级配置，任何登录用户都可在
    「设置」中编辑其模型 / 温度 / 技能绑定。这里只排除「其他用户创建」的行，
    把跨用户越权堵住，而不改变原有的单用户使用行为。
    """
    return select(AIModel).where(
        AIModel.id == model_id,
        or_(AIModel.user_id == db_user_id, AIModel.user_id.is_(None)),
    )


def owned_assistant(
    db_user_id: uuid.UUID, assistant_id: uuid.UUID,
) -> Select:
    """按 ID 取一个**可写**的助手：本人创建，或系统种子（``user_id IS NULL``）。"""
    return select(AIAssistant).where(
        AIAssistant.id == assistant_id,
        or_(AIAssistant.user_id == db_user_id, AIAssistant.user_id.is_(None)),
    )


async def find_model_by_ref(
    db: AsyncSession,
    user_id: uuid.UUID,
    ref: str,
    *,
    is_guest: bool = False,
) -> AIModel | None:
    """按名称或 model_id 解析模型，**限定在当前用户可见范围内**。

    原本按名称全局匹配，会让用户用一个名字引用到别人的模型；这里限定作用域。
    """
    from sqlalchemy import or_ as _or

    stmt = models_visible_to(user_id, is_guest=is_guest).where(
        AIModel.is_deleted == False,  # noqa: E712
        _or(AIModel.name == ref, AIModel.model_id == ref),
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def resolve_default_model(
    db: AsyncSession, user_id: uuid.UUID, *, is_guest: bool = False,
) -> AIModel | None:
    """兜底模型：优先用户设置的默认模型，否则取其可见范围内任意一个。

    原来是 ``limit(1)`` 全库随机取——那会让用户用上陌生人的付费 Key。
    """
    us_result = await db.execute(select(UserAISettings).where(UserAISettings.user_id == user_id))
    user_settings = us_result.scalar_one_or_none()
    if user_settings and user_settings.default_model_name:
        stmt = models_visible_to(user_id, is_guest=is_guest).where(
            AIModel.name == user_settings.default_model_name,
            AIModel.is_deleted == False,  # noqa: E712
        )
        found = (await db.execute(stmt)).scalar_one_or_none()
        if found is not None:
            return found

    stmt = models_visible_to(user_id, is_guest=is_guest).where(
        AIModel.is_deleted == False,  # noqa: E712
    ).limit(1)
    return (await db.execute(stmt)).scalar_one_or_none()
