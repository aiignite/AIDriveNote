"""AI platform REST API."""
from __future__ import annotations

import json
import uuid
from datetime import datetime
import time
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.ai_tools.registry import ToolRegistry
import app.ai_tools  # noqa: F401
from app.auth import get_current_user
from app.database import get_db
from app.exceptions import BadRequestException, NotFoundException
from app.models.ai import (
    AIAssistant,
    AIAssistantSkillBinding,
    AIConversation,
    AIMessage,
    AIModel,
    AISkill,
    PageSkillBinding,
    UserAISettings,
)
from app.models.user import User
from app.services.ai.ai_service import AIService
from app.services.ai.seed_service import AISeedService
from app.services.ai_providers.factory import AIProviderFactory

router = APIRouter(prefix="/ai", tags=["AI"])


# ── Schemas ──

class AIModelOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    name: str
    modelId: str = Field(validation_alias="model_id")
    provider: str
    endpoint: Optional[str] = None
    description: Optional[str] = None
    isPublic: bool = Field(validation_alias="is_public")
    createdAt: Optional[datetime] = Field(None, validation_alias="created_at")


class AIModelCreate(BaseModel):
    name: str
    model_id: str
    provider: str = "OLLAMA"
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    description: Optional[str] = None
    is_public: bool = True
    popularity: int = 50
    speed: str = "Fast"
    cost: str = "$"
    context: str = "128K"
    supports_text: bool = True
    supports_image: bool = False
    set_as_default: bool = False


class AIModelUpdate(BaseModel):
    name: Optional[str] = None
    model_id: Optional[str] = None
    provider: Optional[str] = None
    endpoint: Optional[str] = None
    api_key: Optional[str] = None
    description: Optional[str] = None
    is_public: Optional[bool] = None
    popularity: Optional[int] = None
    speed: Optional[str] = None
    cost: Optional[str] = None
    context: Optional[str] = None
    supports_text: Optional[bool] = None
    supports_image: Optional[bool] = None
    set_as_default: Optional[bool] = None


class AIAssistantOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    name: str
    description: Optional[str] = None
    avatar: Optional[str] = None
    role: Optional[str] = None
    category: Optional[str] = None
    systemPrompt: str = Field(validation_alias="system_prompt")
    model: Optional[str] = None
    temperature: Optional[float] = None
    maxTokens: Optional[int] = Field(None, validation_alias="max_tokens")
    isSystem: bool = Field(validation_alias="is_system")
    isDefault: bool = Field(validation_alias="is_default")
    tools: Optional[list[str]] = None


class AIAssistantUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    avatar: Optional[str] = None
    role: Optional[str] = None
    category: Optional[str] = None
    system_prompt: Optional[str] = None
    model: Optional[str] = None
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    is_default: Optional[bool] = None
    tools: Optional[list[str]] = None


class AIAssistantCreate(BaseModel):
    name: str
    description: Optional[str] = None
    avatar: Optional[str] = None
    role: Optional[str] = None
    category: Optional[str] = "General"
    system_prompt: str
    model: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 16384
    is_default: bool = False
    tools: Optional[list[str]] = None


class AISettingsOut(BaseModel):
    defaultModelName: Optional[str] = None
    defaultProvider: Optional[str] = None
    sidebarWidth: int = 400


class AISettingsUpdate(BaseModel):
    default_model_name: Optional[str] = None
    default_provider: Optional[str] = None
    sidebar_width: Optional[int] = None


class ConversationOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    title: Optional[str] = None
    assistantName: Optional[str] = Field(None, validation_alias="assistant_name")
    model: Optional[str] = None
    createdAt: Optional[datetime] = Field(None, validation_alias="created_at")
    updatedAt: Optional[datetime] = Field(None, validation_alias="updated_at")


class MessageOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    role: str
    content: str
    toolResults: Optional[list] = Field(None, validation_alias="tool_results")
    createdAt: Optional[datetime] = Field(None, validation_alias="created_at")


class ChatStreamRequest(BaseModel):
    message: str
    assistant_name: Optional[str] = "笔记助手"
    conversation_id: Optional[uuid.UUID] = None
    model_id: Optional[str] = None
    page_context: Optional[dict[str, Any]] = None


class SkillOut(BaseModel):
    model_config = {"from_attributes": True}
    id: uuid.UUID
    code: str
    name: str
    description: Optional[str] = None
    promptTemplate: str = Field(validation_alias="prompt_template")
    toolNames: list = Field(validation_alias="tool_names")
    keywords: list = Field(default_factory=list)
    priority: int = 50
    isEnabled: bool = Field(validation_alias="is_enabled")
    isBuiltin: bool = Field(validation_alias="is_builtin")


class SkillBindingItem(BaseModel):
    skill_id: uuid.UUID
    weight: int = 50
    is_enabled: bool = True


class SkillCreate(BaseModel):
    code: str
    name: str
    description: Optional[str] = None
    prompt_template: str = ""
    tool_names: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    priority: int = 50
    is_enabled: bool = True


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    prompt_template: Optional[str] = None
    tool_names: Optional[list[str]] = None
    keywords: Optional[list[str]] = None
    priority: Optional[int] = None
    is_enabled: Optional[bool] = None


def _skill_to_out(s: AISkill) -> dict[str, Any]:
    return {
        "id": s.id,
        "code": s.code,
        "name": s.name,
        "description": s.description,
        "promptTemplate": s.prompt_template,
        "toolNames": s.tool_names or [],
        "keywords": s.keywords or [],
        "priority": s.priority,
        "isEnabled": s.is_enabled,
        "isBuiltin": s.is_builtin,
    }


def _model_to_out(m: AIModel, *, is_default: bool = False) -> dict[str, Any]:
    return {
        "id": m.id,
        "name": m.name,
        "modelId": m.model_id,
        "provider": m.provider,
        "endpoint": m.endpoint,
        "description": m.description,
        "isPublic": m.is_public,
        "isDefault": is_default,
        "popularity": m.popularity,
        "speed": m.speed,
        "cost": m.cost,
        "context": m.context,
        "supportsText": m.supports_text,
        "supportsImage": m.supports_image,
        "hasApiKey": bool(m.api_key),
        "createdAt": m.created_at,
    }


def _assistant_to_out(a: AIAssistant) -> dict[str, Any]:
    return {
        "id": a.id,
        "name": a.name,
        "description": a.description,
        "avatar": a.avatar,
        "role": a.role,
        "category": a.category,
        "systemPrompt": a.system_prompt,
        "model": a.model,
        "temperature": a.temperature,
        "maxTokens": a.max_tokens,
        "isSystem": a.is_system,
        "isDefault": a.is_default,
        "tools": a.tools or [],
        "createdAt": a.created_at,
    }


async def _clear_default_assistants(db: AsyncSession, *, except_id: uuid.UUID | None = None) -> None:
    result = await db.execute(
        select(AIAssistant).where(AIAssistant.is_deleted == False, AIAssistant.is_default == True)  # noqa: E712
    )
    for assistant in result.scalars().all():
        if except_id and assistant.id == except_id:
            continue
        assistant.is_default = False


async def _get_user_default_model_name(db: AsyncSession, user_id: uuid.UUID) -> str | None:
    result = await db.execute(select(UserAISettings).where(UserAISettings.user_id == user_id))
    settings = result.scalar_one_or_none()
    return settings.default_model_name if settings else None


async def _set_user_default_model(db: AsyncSession, user_id: uuid.UUID, model_name: str) -> None:
    result = await db.execute(select(UserAISettings).where(UserAISettings.user_id == user_id))
    settings = result.scalar_one_or_none()
    if not settings:
        settings = UserAISettings(user_id=user_id)
        db.add(settings)
    settings.default_model_name = model_name


async def _clear_user_default_model_if_matches(
    db: AsyncSession, user_id: uuid.UUID, model_name: str,
) -> None:
    result = await db.execute(select(UserAISettings).where(UserAISettings.user_id == user_id))
    settings = result.scalar_one_or_none()
    if settings and settings.default_model_name == model_name:
        settings.default_model_name = None


# ── Models ──

@router.get("/models")
async def list_models(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    default_name = await _get_user_default_model_name(db, user.id)
    result = await db.execute(
        select(AIModel).where(AIModel.is_deleted == False).order_by(AIModel.name)  # noqa: E712
    )
    return [
        _model_to_out(m, is_default=bool(default_name and m.name == default_name))
        for m in result.scalars().all()
    ]


@router.post("/models", status_code=201)
async def create_model(
    body: AIModelCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    payload = body.model_dump(exclude={"set_as_default"})
    m = AIModel(**payload, user_id=user.id)
    db.add(m)
    await db.flush()
    if body.set_as_default:
        await _set_user_default_model(db, user.id, m.name)
    await db.commit()
    await db.refresh(m)
    is_default = body.set_as_default
    return _model_to_out(m, is_default=is_default)


@router.put("/models/{model_id}")
async def update_model(
    model_id: uuid.UUID,
    body: AIModelUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AIModel).where(AIModel.id == model_id, AIModel.is_deleted == False))  # noqa: E712
    m = result.scalar_one_or_none()
    if not m:
        raise NotFoundException("AIModel")
    updates = body.model_dump(exclude_unset=True)
    set_as_default = updates.pop("set_as_default", None)
    for k, v in updates.items():
        if k == "api_key" and not v:
            continue
        setattr(m, k, v)
    if set_as_default is True:
        await _set_user_default_model(db, user.id, m.name)
    elif set_as_default is False:
        await _clear_user_default_model_if_matches(db, user.id, m.name)
    await db.commit()
    await db.refresh(m)
    default_name = await _get_user_default_model_name(db, user.id)
    return _model_to_out(m, is_default=bool(default_name and m.name == default_name))


@router.delete("/models/{model_id}", status_code=204)
async def delete_model(
    model_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AIModel).where(AIModel.id == model_id, AIModel.is_deleted == False))  # noqa: E712
    m = result.scalar_one_or_none()
    if not m:
        raise NotFoundException("AIModel")
    m.is_deleted = True
    await db.commit()


def _resolve_api_key(model_key: str | None, env_key: str | None) -> str | None:
    key = (model_key or "").strip() or (env_key or "").strip()
    return key or None


@router.post("/models/{model_id}/test-connection")
async def test_model_connection(
    model_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.config import get_settings

    result = await db.execute(select(AIModel).where(AIModel.id == model_id, AIModel.is_deleted == False))  # noqa: E712
    m = result.scalar_one_or_none()
    if not m:
        raise NotFoundException("AIModel")

    settings = get_settings()
    provider = (m.provider or "OLLAMA").upper()
    started = time.time()

    def _result(ok: bool, message: str, *, error: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "success": ok,
            "ok": ok,
            "message": message,
            "provider": provider,
            "model": m.model_id,
            "latencyMs": int((time.time() - started) * 1000),
        }
        if error:
            payload["error"] = error
        return payload

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            if provider == "OLLAMA":
                url = (m.endpoint or settings.OLLAMA_BASE_URL or "http://localhost:11434").rstrip("/")
                resp = await client.get(f"{url}/api/tags")
                resp.raise_for_status()
                return _result(True, "Ollama 连接成功")

            if provider == "LMSTUDIO":
                url = (m.endpoint or "http://localhost:1234").rstrip("/")
                resp = await client.get(f"{url}/v1/models")
                resp.raise_for_status()
                return _result(True, "LM Studio 连接成功")

            if provider == "OPENAI":
                api_key = _resolve_api_key(m.api_key, settings.OPENAI_API_KEY)
                if not api_key:
                    return _result(False, "缺少 API Key", error="请填写模型 API Key 或在环境变量中配置 OPENAI_API_KEY")
                url = (m.endpoint or "https://api.openai.com/v1").rstrip("/")
                resp = await client.get(f"{url}/models", headers={"Authorization": f"Bearer {api_key}"})
                resp.raise_for_status()
                return _result(True, "OpenAI 连接成功")

            if provider == "ANTHROPIC":
                api_key = _resolve_api_key(m.api_key, settings.ANTHROPIC_API_KEY)
                if not api_key:
                    return _result(False, "缺少 API Key", error="请填写模型 API Key 或在环境变量中配置 ANTHROPIC_API_KEY")
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": m.model_id,
                        "max_tokens": 16,
                        "messages": [{"role": "user", "content": "hi"}],
                    },
                )
                if resp.status_code >= 400:
                    return _result(False, "Anthropic 连接失败", error=resp.text[:500])
                return _result(True, "Anthropic 连接成功")

            if provider == "MINIMAX":
                api_key = _resolve_api_key(m.api_key, settings.MINIMAX_API_KEY)
                if not api_key:
                    return _result(False, "缺少 API Key", error="请填写模型 API Key 或在环境变量中配置 MINIMAX_API_KEY")
                url = (m.endpoint or "https://api.minimax.chat/v1").rstrip("/")
                resp = await client.post(
                    f"{url}/text/chatcompletion_v2",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": m.model_id,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 16,
                    },
                )
                if resp.status_code >= 400:
                    return _result(False, "MiniMax 连接失败", error=resp.text[:500])
                try:
                    data = resp.json()
                except json.JSONDecodeError:
                    return _result(False, "MiniMax 连接失败", error=resp.text[:500])
                base_resp = data.get("base_resp") or {}
                status_code = base_resp.get("status_code", 0)
                if status_code not in (0, None):
                    msg = base_resp.get("status_msg") or f"错误码 {status_code}"
                    return _result(False, "MiniMax 连接失败", error=msg)
                return _result(True, "MiniMax 连接成功")

            return _result(False, f"不支持的提供商: {provider}", error=f"unsupported provider: {provider}")
    except Exception as exc:
        return _result(False, "连接测试失败", error=str(exc)[:500])


# ── Assistants ──

@router.get("/assistants")
async def list_assistants(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await AISeedService.ensure_platform_seed(db)
    result = await db.execute(
        select(AIAssistant).where(AIAssistant.is_deleted == False).order_by(AIAssistant.name)  # noqa: E712
    )
    return [_assistant_to_out(a) for a in result.scalars().all()]


@router.post("/assistants", status_code=201)
async def create_assistant(
    body: AIAssistantCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.is_default:
        await _clear_default_assistants(db)
    assistant = AIAssistant(**body.model_dump(), user_id=user.id, is_system=False)
    db.add(assistant)
    await db.commit()
    await db.refresh(assistant)
    return _assistant_to_out(assistant)


@router.put("/assistants/{assistant_id}")
async def update_assistant(
    assistant_id: uuid.UUID,
    body: AIAssistantUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AIAssistant).where(AIAssistant.id == assistant_id, AIAssistant.is_deleted == False))  # noqa: E712
    a = result.scalar_one_or_none()
    if not a:
        raise NotFoundException("AIAssistant")
    updates = body.model_dump(exclude_unset=True)
    if updates.get("is_default"):
        await _clear_default_assistants(db, except_id=a.id)
    for k, v in updates.items():
        setattr(a, k, v)
    await db.commit()
    await db.refresh(a)
    return _assistant_to_out(a)


@router.delete("/assistants/{assistant_id}", status_code=204)
async def delete_assistant(
    assistant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AIAssistant).where(AIAssistant.id == assistant_id, AIAssistant.is_deleted == False))  # noqa: E712
    a = result.scalar_one_or_none()
    if not a:
        raise NotFoundException("AIAssistant")
    if a.is_system:
        raise BadRequestException("系统助手不允许删除")
    a.is_deleted = True
    await db.commit()


@router.post("/assistants/{assistant_id}/clone", status_code=201)
async def clone_assistant(
    assistant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(AIAssistant).where(AIAssistant.id == assistant_id, AIAssistant.is_deleted == False))  # noqa: E712
    src = result.scalar_one_or_none()
    if not src:
        raise NotFoundException("AIAssistant")
    clone = AIAssistant(
        name=f"{src.name} (副本)",
        description=src.description,
        avatar=src.avatar,
        role=src.role,
        category=src.category,
        system_prompt=src.system_prompt,
        model=src.model,
        temperature=src.temperature,
        max_tokens=src.max_tokens,
        tools=list(src.tools or []),
        is_system=False,
        is_default=False,
        user_id=user.id,
    )
    db.add(clone)
    await db.commit()
    await db.refresh(clone)
    return _assistant_to_out(clone)


# ── Settings ──

@router.get("/settings")
async def get_settings(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    result = await db.execute(select(UserAISettings).where(UserAISettings.user_id == user.id))
    s = result.scalar_one_or_none()
    if not s:
        return {"defaultModelName": None, "defaultProvider": None, "sidebarWidth": 400}
    return {
        "defaultModelName": s.default_model_name,
        "defaultProvider": s.default_provider,
        "sidebarWidth": s.sidebar_width,
    }


@router.put("/settings")
async def update_settings(
    body: AISettingsUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(select(UserAISettings).where(UserAISettings.user_id == user.id))
    s = result.scalar_one_or_none()
    if not s:
        s = UserAISettings(user_id=user.id)
        db.add(s)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    await db.commit()
    return {
        "defaultModelName": s.default_model_name,
        "defaultProvider": s.default_provider,
        "sidebarWidth": s.sidebar_width,
    }


# ── Providers & Tools ──

@router.get("/providers")
async def list_providers(user: User = Depends(get_current_user)):
    return AIProviderFactory.get_available_providers()


@router.get("/tools/registry")
async def tools_registry(user: User = Depends(get_current_user)):
    return ToolRegistry.get_registry_metadata()


# ── Conversations ──

@router.get("/conversations")
async def list_conversations(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AIConversation)
        .where(AIConversation.user_id == user.id, AIConversation.is_deleted == False)  # noqa: E712
        .order_by(desc(AIConversation.updated_at))
        .limit(50)
    )
    return [
        {
            "id": c.id,
            "title": c.title,
            "assistantName": c.assistant_name,
            "model": c.model,
            "createdAt": c.created_at,
            "updatedAt": c.updated_at,
        }
        for c in result.scalars().all()
    ]


@router.post("/conversations", status_code=201)
async def create_conversation(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    assistant_name: str = "笔记助手",
):
    conv = AIConversation(user_id=user.id, title="新对话", assistant_name=assistant_name)
    db.add(conv)
    await db.commit()
    await db.refresh(conv)
    return {"id": conv.id, "title": conv.title, "assistantName": conv.assistant_name}


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AIConversation).where(
            AIConversation.id == conversation_id,
            AIConversation.user_id == user.id,
            AIConversation.is_deleted == False,  # noqa: E712
        )
    )
    conv = result.scalar_one_or_none()
    if not conv:
        raise NotFoundException("AIConversation")
    conv.is_deleted = True
    await db.commit()


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AIConversation).where(
            AIConversation.id == conversation_id,
            AIConversation.user_id == user.id,
            AIConversation.is_deleted == False,  # noqa: E712
        )
    )
    if not result.scalar_one_or_none():
        raise NotFoundException("AIConversation")
    msg_result = await db.execute(
        select(AIMessage)
        .where(AIMessage.conversation_id == conversation_id, AIMessage.is_deleted == False)  # noqa: E712
        .order_by(AIMessage.created_at)
    )
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "toolResults": m.tool_results or [],
            "createdAt": m.created_at,
        }
        for m in msg_result.scalars().all()
    ]


# ── Skills ──

@router.get("/skills")
async def list_skills(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await AISeedService.ensure_platform_seed(db)
    result = await db.execute(
        select(AISkill).where(AISkill.is_deleted == False).order_by(desc(AISkill.priority))  # noqa: E712
    )
    return [_skill_to_out(s) for s in result.scalars().all()]


@router.post("/skills", status_code=201)
async def create_skill(
    body: SkillCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    code = body.code.strip()
    if not code:
        raise BadRequestException("技能代码不能为空")
    existing = await db.execute(
        select(AISkill).where(AISkill.code == code, AISkill.is_deleted == False)  # noqa: E712
    )
    if existing.scalar_one_or_none():
        raise BadRequestException(f"技能代码「{code}」已存在")
    skill = AISkill(
        code=code,
        name=body.name.strip(),
        description=body.description,
        prompt_template=body.prompt_template,
        tool_names=body.tool_names,
        keywords=body.keywords,
        priority=body.priority,
        is_enabled=body.is_enabled,
        is_builtin=False,
    )
    db.add(skill)
    await db.commit()
    await db.refresh(skill)
    return _skill_to_out(skill)


@router.put("/skills/{skill_id}")
async def update_skill(
    skill_id: uuid.UUID,
    body: SkillUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AISkill).where(AISkill.id == skill_id, AISkill.is_deleted == False)  # noqa: E712
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise NotFoundException("AISkill")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(skill, k, v)
    await db.commit()
    await db.refresh(skill)
    return _skill_to_out(skill)


@router.delete("/skills/{skill_id}", status_code=204)
async def delete_skill(
    skill_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AISkill).where(AISkill.id == skill_id, AISkill.is_deleted == False)  # noqa: E712
    )
    skill = result.scalar_one_or_none()
    if not skill:
        raise NotFoundException("AISkill")
    if skill.is_builtin:
        raise BadRequestException("内置技能不允许删除，可改为禁用")
    skill.is_deleted = True
    await db.commit()


@router.get("/page-skills/notes")
async def get_page_skills(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    result = await db.execute(
        select(PageSkillBinding)
        .join(AISkill)
        .where(
            PageSkillBinding.page_name == "notes",
            PageSkillBinding.is_deleted == False,  # noqa: E712
        )
        .options(selectinload(PageSkillBinding.skill))
    )
    return [
        {
            "skillId": b.skill_id,
            "skillName": b.skill.name,
            "weight": b.weight,
            "isEnabled": b.is_enabled,
        }
        for b in result.scalars().all()
    ]


@router.put("/page-skills/notes")
async def save_page_skills(
    items: list[SkillBindingItem],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    for item in items:
        result = await db.execute(
            select(PageSkillBinding).where(
                PageSkillBinding.page_name == "notes",
                PageSkillBinding.skill_id == item.skill_id,
            )
        )
        binding = result.scalar_one_or_none()
        if binding:
            binding.weight = item.weight
            binding.is_enabled = item.is_enabled
            binding.is_deleted = False
        else:
            db.add(PageSkillBinding(
                page_name="notes", skill_id=item.skill_id,
                weight=item.weight, is_enabled=item.is_enabled,
            ))
    await db.commit()
    return {"success": True}


@router.get("/assistants/{assistant_id}/skills")
async def get_assistant_skills(
    assistant_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(AIAssistantSkillBinding)
        .where(
            AIAssistantSkillBinding.assistant_id == assistant_id,
            AIAssistantSkillBinding.is_deleted == False,  # noqa: E712
        )
        .options(selectinload(AIAssistantSkillBinding.skill))
    )
    return [
        {
            "skillId": b.skill_id,
            "skillName": b.skill.name if b.skill else "",
            "weight": b.weight,
            "isEnabled": b.is_enabled,
        }
        for b in result.scalars().all()
    ]


@router.put("/assistants/{assistant_id}/skills")
async def save_assistant_skills(
    assistant_id: uuid.UUID,
    items: list[SkillBindingItem],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    for item in items:
        result = await db.execute(
            select(AIAssistantSkillBinding).where(
                AIAssistantSkillBinding.assistant_id == assistant_id,
                AIAssistantSkillBinding.skill_id == item.skill_id,
            )
        )
        binding = result.scalar_one_or_none()
        if binding:
            binding.weight = item.weight
            binding.is_enabled = item.is_enabled
            binding.is_deleted = False
        else:
            db.add(AIAssistantSkillBinding(
                assistant_id=assistant_id, skill_id=item.skill_id,
                weight=item.weight, is_enabled=item.is_enabled,
            ))
    await db.commit()
    return {"success": True}


# ── Chat stream ──

@router.post("/chat/stream")
async def chat_stream(
    body: ChatStreamRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    async def event_generator():
        async for chunk in AIService.chat_stream(
            db,
            user.id,
            body.message,
            assistant_name=body.assistant_name,
            conversation_id=body.conversation_id,
            page_context=body.page_context,
            model_id=body.model_id,
        ):
            yield chunk

    return StreamingResponse(event_generator(), media_type="text/event-stream")
