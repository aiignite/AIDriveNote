"""Tests for AI platform seed, assistants, models, and skills."""
from __future__ import annotations

import uuid

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.services.ai.seed_service import AISeedService
from app.services.ai_skills.skill_router import SkillRouter

import app.ai_tools  # noqa: F401


async def _create_user(db: AsyncSession, email: str = "ai@test.com") -> User:
    hashed = bcrypt.hashpw(b"test_password", bcrypt.gensalt(12)).decode("utf-8")
    user = User(email=email, password_hash=hashed, name="AI Tester")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest.mark.asyncio
async def test_seed_creates_note_assistant_and_skills(db_session: AsyncSession):
    await AISeedService.ensure_platform_seed(db_session)

    from sqlalchemy import select
    from app.models.ai import AIAssistant, AISkill, PageSkillBinding

    asst = (await db_session.execute(
        select(AIAssistant).where(AIAssistant.name == "笔记助手")
    )).scalar_one_or_none()
    assert asst is not None
    assert asst.is_system is True
    assert len(asst.tools or []) >= 10

    skills = (await db_session.execute(select(AISkill))).scalars().all()
    assert len(skills) >= 5

    bindings = (await db_session.execute(
        select(PageSkillBinding).where(PageSkillBinding.page_name == "notes")
    )).scalars().all()
    assert len(bindings) >= 5


@pytest.mark.asyncio
async def test_skill_router_matches_summarize_keyword(db_session: AsyncSession):
    await AISeedService.ensure_platform_seed(db_session)
    from sqlalchemy import select
    from app.models.ai import AIAssistant

    assistant = (await db_session.execute(
        select(AIAssistant).where(AIAssistant.name == "笔记助手")
    )).scalar_one()

    match = await SkillRouter.resolve_for_page(
        db_session,
        page_name="notes",
        message="请帮我总结一下这篇笔记",
        assistant=assistant,
    )
    assert match is not None
    assert match.skill.code == "note_read_summarize"


@pytest_asyncio.fixture
async def authed_client(db_session):
    from app.main import app

    user = await _create_user(db_session)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    from app.auth import get_current_user

    async def override_user():
        return user

    app.dependency_overrides[get_current_user] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_list_assistants_api(authed_client: AsyncClient):
    res = await authed_client.get("/ai/assistants")
    assert res.status_code == 200
    data = res.json()
    assert any(a["name"] == "笔记助手" for a in data)
    note = next(a for a in data if a["name"] == "笔记助手")
    assert len(note.get("tools") or []) >= 10


@pytest.mark.asyncio
async def test_models_crud(authed_client: AsyncClient):
    create = await authed_client.post("/ai/models", json={
        "name": "Test/Ollama",
        "model_id": "qwen2.5",
        "provider": "OLLAMA",
        "endpoint": "http://localhost:11434",
    })
    assert create.status_code == 201
    model_id = create.json()["id"]

    listing = await authed_client.get("/ai/models")
    assert listing.status_code == 200
    assert any(m["id"] == model_id for m in listing.json())

    delete = await authed_client.delete(f"/ai/models/{model_id}")
    assert delete.status_code == 204


@pytest.mark.asyncio
async def test_settings_get_put(authed_client: AsyncClient):
    put = await authed_client.put("/ai/settings", json={
        "default_model_name": "Ollama/qwen2.5",
        "sidebar_width": 420,
    })
    assert put.status_code == 200
    assert put.json()["sidebarWidth"] == 420

    get = await authed_client.get("/ai/settings")
    assert get.status_code == 200
    assert get.json()["sidebarWidth"] == 420


@pytest.mark.asyncio
async def test_tools_registry(authed_client: AsyncClient):
    res = await authed_client.get("/ai/tools/registry")
    assert res.status_code == 200
    data = res.json()
    assert "categories" in data
    assert "note" in data["categories"]


@pytest.mark.asyncio
async def test_list_skills(authed_client: AsyncClient):
    res = await authed_client.get("/ai/skills")
    assert res.status_code == 200
    codes = {s["code"] for s in res.json()}
    assert "note_read_summarize" in codes
    assert "note_continue" in codes


@pytest.mark.asyncio
async def test_system_assistant_is_read_only(authed_client: AsyncClient):
    """系统助手对普通用户只读——改它必须先克隆。

    模型/助手已按 user_id 严格归属，系统种子（user_id IS NULL）不属于任何用户，
    因此不允许直接编辑，避免一人改配置全站生效。
    """
    listing = await authed_client.get("/ai/assistants")
    assert listing.status_code == 200
    system = next(a for a in listing.json() if a["name"] == "笔记助手")

    create = await authed_client.post("/ai/models", json={
        "name": "Alt/Ollama",
        "model_id": "llama3",
        "provider": "OLLAMA",
        "endpoint": "http://localhost:11434",
    })
    assert create.status_code == 201

    update = await authed_client.put(f"/ai/assistants/{system['id']}", json={
        "model": "Alt/Ollama",
        "temperature": 0.5,
    })
    assert update.status_code == 404, "系统助手不应可编辑"

    delete = await authed_client.delete(f"/ai/assistants/{system['id']}")
    assert delete.status_code == 404, "系统助手不应可删除"

    # 克隆后即可自由编辑
    clone = await authed_client.post(f"/ai/assistants/{system['id']}/clone")
    assert clone.status_code == 201
    cloned_id = clone.json()["id"]
    edit = await authed_client.put(f"/ai/assistants/{cloned_id}", json={
        "model": "Alt/Ollama",
        "temperature": 0.5,
    })
    assert edit.status_code == 200
    assert edit.json()["model"] == "Alt/Ollama"
    assert edit.json()["temperature"] == 0.5

    # 列表接口会触发 ensure_platform_seed，不得把系统助手覆盖回默认值
    relist = await authed_client.get("/ai/assistants")
    assert relist.status_code == 200
    note = next(a for a in relist.json() if a["name"] == "笔记助手")
    assert note["temperature"] != 0.5, "系统助手不应被普通用户的修改影响"


@pytest.mark.asyncio
async def test_create_and_delete_custom_assistant(authed_client: AsyncClient):
    create = await authed_client.post("/ai/assistants", json={
        "name": "测试助手",
        "role": "测试",
        "system_prompt": "你是测试助手",
        "model": "Ollama/qwen2.5",
    })
    assert create.status_code == 201
    assistant_id = create.json()["id"]

    delete = await authed_client.delete(f"/ai/assistants/{assistant_id}")
    assert delete.status_code == 204


@pytest_asyncio.fixture
async def admin_client(db_session):
    from app.auth import get_current_user
    from app.main import app

    user = await _create_user(db_session, "admin@test.com")
    user.role = "admin"
    await db_session.commit()

    async def override_get_db():
        yield db_session

    async def override_user():
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_admin_can_edit_system_model(admin_client: AsyncClient, db_session: AsyncSession):
    """管理员可改系统预置模型的参数，改名后同步引用，普通用户仍然只能改自己的。"""
    from app.models.ai import AIAssistant, AIModel

    system_model = AIModel(
        name="GLM5.3F",
        model_id="glm-5.3-flash",
        provider="OPENAI",
        endpoint="https://open.bigmodel.cn/api/coding/paas/v4",
        context="1M",
    )
    assistant = AIAssistant(
        name="引用该模型的助手", system_prompt="prompt", model="GLM5.3F", user_id=None,
    )
    db_session.add_all([system_model, assistant])
    await db_session.commit()
    await db_session.refresh(system_model)

    res = await admin_client.put(
        f"/ai/models/{system_model.id}",
        json={"context": "512K", "description": "平台主力模型"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["context"] == "512K"

    await db_session.refresh(system_model)
    assert system_model.user_id is None
    assert system_model.context == "512K"

    renamed = await admin_client.put(f"/ai/models/{system_model.id}", json={"name": "GLM5.3F-512K"})
    assert renamed.status_code == 200, renamed.text
    await db_session.refresh(assistant)
    assert assistant.model == "GLM5.3F-512K"


@pytest.mark.asyncio
async def test_normal_user_cannot_edit_system_model(
    authed_client: AsyncClient, db_session: AsyncSession,
):
    from app.models.ai import AIModel

    system_model = AIModel(name="Seed/Ollama", model_id="qwen2.5", provider="OLLAMA", context="128K")
    db_session.add(system_model)
    await db_session.commit()
    await db_session.refresh(system_model)

    res = await authed_client.put(f"/ai/models/{system_model.id}", json={"context": "512K"})
    assert res.status_code == 404
