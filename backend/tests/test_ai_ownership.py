"""AI 模型 / 助手的归属隔离测试。

修复前 ``ai_models.user_id`` 与 ``ai_assistants.user_id`` 是「只写不读」字段：
写入时记录了创建者，但所有查询都不按 user_id 过滤，``LLMRouter`` 甚至用
``limit(1)`` 全库随机取一行兜底——任何用户（包括匿名用户）都会用上他人的模型
与付费 Key，且任何人都能编辑 / 删除他人的模型。

本测试文件锁定以下口径：

- 列表：仅「系统种子 + 本人创建」，看不到他人模型；
- 读写删改：仅限本人创建，系统种子与其他用户的一律 404；
- 模型解析（``LLMRouter``）：限定在调用者可见范围内，不会兜底到陌生人的 Key；
- 匿名用户：只能用自己创建的模型，连系统种子也看不到；无模型时明确报错，
  而不是静默回退到站点所有者的环境变量。
"""
from __future__ import annotations

import uuid

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.main import app
from app.models.ai import AIAssistant, AIModel
from app.models.user import User
from app.services.ai.llm_router import LLMRouter, NoAvailableModelError


async def _make_user(db: AsyncSession, email: str, *, is_guest: bool = False) -> User:
    user = User(
        email=email,
        password_hash=bcrypt.hashpw(b"pw123456", bcrypt.gensalt(12)).decode(),
        name="U", role="guest" if is_guest else "user", status="Active", is_guest=is_guest,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _make_model(db: AsyncSession, owner: User | None, name: str) -> AIModel:
    model = AIModel(
        name=name, model_id=f"m-{uuid.uuid4().hex[:6]}", provider="OPENAI",
        endpoint="https://api.example.com", api_key="sk-paid-key-owner",
        user_id=owner.id if owner else None,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    return model


async def _make_assistant(db: AsyncSession, owner: User | None, name: str) -> AIAssistant:
    assistant = AIAssistant(
        name=name, system_prompt="p", user_id=owner.id if owner else None, is_system=owner is None,
    )
    db.add(assistant)
    await db.commit()
    await db.refresh(assistant)
    return assistant


@pytest_asyncio.fixture
def api(db_session: AsyncSession):
    """按 user_id 切换身份的 client 工厂。"""

    def _make(user: User) -> AsyncClient:
        async def override_get_db():
            yield db_session

        async def override_user():
            return user

        app.dependency_overrides[get_db] = override_get_db
        app.dependency_overrides[get_current_user] = override_user
        return AsyncClient(transport=ASGITransport(app=app), base_url="http://test/api/v1")

    yield _make
    app.dependency_overrides.clear()


# ── 列表可见性 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_model_list_hides_other_users_models(db_session: AsyncSession, api):
    alice = await _make_user(db_session, "alice-owner@t.com")
    bob = await _make_user(db_session, "bob-owner@t.com")
    system = await _make_model(db_session, None, "Sys/Model")
    alice_model = await _make_model(db_session, alice, "Alice/Model")
    await _make_model(db_session, bob, "Bob/Model")

    async with api(alice) as ac:
        res = await ac.get("/ai/models")
    assert res.status_code == 200
    names = {m["name"] for m in res.json()}
    assert names == {"Sys/Model", "Alice/Model"}, "不应看到他人模型"
    assert "Bob/Model" not in names
    assert system.id and alice_model.id


@pytest.mark.asyncio
async def test_guest_model_list_excludes_system_seed(db_session: AsyncSession, api):
    """匿名用户只能看到自己创建的模型，连系统种子也看不到。"""
    guest = await _make_user(db_session, "g-list@guest.local", is_guest=True)
    system = await _make_model(db_session, None, "Sys/Model")
    await _make_model(db_session, guest, "Guest/Model")

    async with api(guest) as ac:
        res = await ac.get("/ai/models")
    names = {m["name"] for m in res.json()}
    assert names == {"Guest/Model"}
    assert system.name not in names, "系统种子不应出现在匿名列表中"


@pytest.mark.asyncio
async def test_assistant_list_hides_other_users_assistants(db_session: AsyncSession, api):
    alice = await _make_user(db_session, "alice-as@t.com")
    bob = await _make_user(db_session, "bob-as@t.com")
    await _make_assistant(db_session, None, "系统助手")
    await _make_assistant(db_session, alice, "Alice助手")
    await _make_assistant(db_session, bob, "Bob助手")

    async with api(alice) as ac:
        # 该接口会触发 ensure_platform_seed，会额外注入内置系统助手
        res = await ac.get("/ai/assistants")
    names = {a["name"] for a in res.json()}
    assert "Alice助手" in names
    assert "Bob助手" not in names, "不应看到他人助手"
    # 可见的助手只能是系统种子或本人创建
    assert names <= {"系统助手", "Alice助手", "笔记助手", "思维导图设计助手", "流程图设计助手"}


# ── 越权写操作必须被拒绝 ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_cannot_modify_other_users_model(db_session: AsyncSession, api):
    alice = await _make_user(db_session, "alice-mod@t.com")
    bob = await _make_user(db_session, "bob-mod@t.com")
    bob_model = await _make_model(db_session, bob, "Bob/Model")

    async with api(alice) as ac:
        upd = await ac.put(f"/ai/models/{bob_model.id}", json={"name": "Hijacked"})
        dele = await ac.delete(f"/ai/models/{bob_model.id}")
        test_conn = await ac.post(f"/ai/models/{bob_model.id}/test-connection")
    assert upd.status_code == 404, "不得修改他人模型"
    assert dele.status_code == 404, "不得删除他人模型"
    assert test_conn.status_code == 404, "不得探测他人模型"

    still_there = (await db_session.execute(
        select(AIModel).where(AIModel.id == bob_model.id)
    )).scalar_one_or_none()
    assert still_there is not None and still_there.name == "Bob/Model"


@pytest.mark.asyncio
async def test_can_test_connection_on_system_seed(db_session: AsyncSession, api, monkeypatch):
    """系统种子的连通性测试放行（回归：曾用 owned_model「可写」口径导致 404）。

    生产实例：系统 OPENCODE 公共免费模型全站可见可用，但 test-connection
    只认本人创建，任何人都无法验证其连通性（线上实测 404）。
    """
    import types

    class _FakeResp:
        status_code = 200
        reason_phrase = "OK"

        def raise_for_status(self) -> None:
            return None

        @property
        def request(self) -> object:  # 兼容错误路径取 resp.request.url
            return types.SimpleNamespace(url="http://fake")

        @property
        def text(self) -> str:
            return ""

        async def aread(self) -> bytes:
            return b""

    class _FakeClient:
        def __init__(self, **kwargs: object) -> None:
            pass

        async def __aenter__(self) -> "_FakeClient":
            return self

        async def __aexit__(self, *exc: object) -> bool:
            return False

        async def get(self, url: str, **kwargs: object) -> _FakeResp:
            return _FakeResp()

        async def post(self, url: str, **kwargs: object) -> _FakeResp:
            # OPENCODE smoke 请求返回 200，表示匿名通道准入成功
            return _FakeResp()

    monkeypatch.setattr(
        "app.routers.ai.platform.httpx",
        types.SimpleNamespace(AsyncClient=_FakeClient),
    )

    oc = await _make_opencode_model(db_session, "OpenCode/mimo-v2.6-flash", "mimo-v2.6-flash-free")
    alice = await _make_user(db_session, "alice-oc-test@t.com")
    async with api(alice) as ac:
        res = await ac.post(f"/ai/models/{oc.id}/test-connection")
    assert res.status_code == 200
    assert res.json()["ok"] is True

    # 匿名用户同样可测 OPENCODE 公共模型，但付费系统种子对其不可见也不可测
    guest = await _make_user(db_session, "g-oc-test@guest.local", is_guest=True)
    paid = await _make_model(db_session, None, "Sys/PaidTestOnly")
    async with api(guest) as ac:
        ok_res = await ac.post(f"/ai/models/{oc.id}/test-connection")
        paid_res = await ac.post(f"/ai/models/{paid.id}/test-connection")
    assert ok_res.status_code == 200
    assert paid_res.status_code == 404, "匿名用户不得探测付费系统种子"


@pytest.mark.asyncio
async def test_cannot_modify_other_users_assistant(db_session: AsyncSession, api):
    alice = await _make_user(db_session, "alice-as2@t.com")
    bob = await _make_user(db_session, "bob-as2@t.com")
    bob_assistant = await _make_assistant(db_session, bob, "Bob助手")

    async with api(alice) as ac:
        upd = await ac.put(f"/ai/assistants/{bob_assistant.id}", json={"role": "hijack"})
        dele = await ac.delete(f"/ai/assistants/{bob_assistant.id}")
        save_skills = await ac.put(
            f"/ai/assistants/{bob_assistant.id}/skills", json=[],
        )
    assert upd.status_code == 404
    assert dele.status_code == 404
    assert save_skills.status_code == 404


@pytest.mark.asyncio
async def test_system_seed_model_not_writable(db_session: AsyncSession, api):
    """系统种子模型可见但不可改，避免一人改动影响全站。"""
    alice = await _make_user(db_session, "alice-sys@t.com")
    system = await _make_model(db_session, None, "Sys/Model")

    async with api(alice) as ac:
        upd = await ac.put(f"/ai/models/{system.id}", json={"name": "Hijack"})
        dele = await ac.delete(f"/ai/models/{system.id}")
    assert upd.status_code == 404
    assert dele.status_code == 404


@pytest.mark.asyncio
async def test_owner_can_still_manage_own_model(db_session: AsyncSession, api):
    """归属校验不得误伤本人对自己模型的正常操作。"""
    alice = await _make_user(db_session, "alice-own@t.com")
    mine = await _make_model(db_session, alice, "Alice/Model")

    async with api(alice) as ac:
        upd = await ac.put(f"/ai/models/{mine.id}", json={"name": "Alice/Model2"})
        assert upd.status_code == 200
        assert upd.json()["name"] == "Alice/Model2"
        dele = await ac.delete(f"/ai/models/{mine.id}")
        assert dele.status_code == 204


# ── 模型解析必须限定在调用者范围内 ─────────────────────────────────


@pytest.mark.asyncio
async def test_llm_router_ignores_other_users_model(db_session: AsyncSession):
    """按名字引用别人的模型时解析不到，不会用上其付费 Key。"""
    alice = await _make_user(db_session, "alice-res@t.com")
    bob = await _make_user(db_session, "bob-res@t.com")
    await _make_model(db_session, bob, "Bob/Model")

    res = await LLMRouter.resolve(db_session, alice.id, request_model="Bob/Model")
    # 解析不到 Bob 的模型 → 落到 env 兜底，而不是返回 Bob 的 api_key
    assert res.api_key is None, "绝不能解析到他人模型的 API Key"
    assert res.model_name != "Bob/Model"


@pytest.mark.asyncio
async def test_llm_router_uses_own_model(db_session: AsyncSession):
    alice = await _make_user(db_session, "alice-res2@t.com")
    await _make_model(db_session, alice, "Alice/Model")

    res = await LLMRouter.resolve(db_session, alice.id, request_model="Alice/Model")
    assert res.model_name == "Alice/Model"
    assert res.api_key == "sk-paid-key-owner"


@pytest.mark.asyncio
async def test_guest_without_model_raises_instead_of_fallback(db_session: AsyncSession):
    """匿名用户无模型时必须明确报错，不得回退到站点所有者的环境配置。"""
    guest = await _make_user(db_session, "g-nomodel@guest.local", is_guest=True)
    await _make_model(db_session, None, "Sys/Model")  # 系统种子对匿名不可见

    with pytest.raises(NoAvailableModelError):
        await LLMRouter.resolve(db_session, guest.id, is_guest=True)


@pytest.mark.asyncio
async def test_guest_uses_own_model(db_session: AsyncSession):
    guest = await _make_user(db_session, "g-own@guest.local", is_guest=True)
    await _make_model(db_session, guest, "Guest/Model")

    res = await LLMRouter.resolve(db_session, guest.id, is_guest=True)
    assert res.model_name == "Guest/Model"


@pytest.mark.asyncio
async def test_guest_never_resolves_system_seed(db_session: AsyncSession):
    """即使显式点名系统模型，匿名用户也不该解析到。"""
    guest = await _make_user(db_session, "g-seed@guest.local", is_guest=True)
    await _make_model(db_session, None, "Sys/Model")

    with pytest.raises(NoAvailableModelError):
        await LLMRouter.resolve(db_session, guest.id, request_model="Sys/Model", is_guest=True)


@pytest.mark.asyncio
async def test_regular_user_falls_back_to_env(db_session: AsyncSession):
    """正式用户没有任何模型时，仍保留原有的 env 兜底行为。"""
    alice = await _make_user(db_session, "alice-fb@t.com")
    res = await LLMRouter.resolve(db_session, alice.id)
    assert res.provider == "OLLAMA"


async def _make_opencode_model(db: AsyncSession, name: str, model_id: str) -> AIModel:
    """系统种子的 OpenCode 公共免费模型（user_id IS NULL，无任何站点 Key）。"""
    model = AIModel(
        name=name, model_id=model_id, provider="OPENCODE",
        endpoint="https://opencode.ai/zen/v1", api_key=None, cost="Free",
        is_public=True, user_id=None,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    return model


@pytest.mark.asyncio
async def test_guest_sees_opencode_public_models(db_session: AsyncSession, api):
    """匿名用户可见系统 OPENCODE 公共免费模型（全站开放），但看不到其他系统种子。"""
    guest = await _make_user(db_session, "g-oc@guest.local", is_guest=True)
    await _make_model(db_session, None, "Sys/PaidModel")  # OPENAI 付费种子
    oc = await _make_opencode_model(db_session, "OpenCode/ling-3.1-flash", "ling-3.1-flash-free")

    async with api(guest) as ac:
        res = await ac.get("/ai/models")
    names = {m["name"] for m in res.json()}
    assert oc.name in names, "OpenCode 公共模型对匿名用户可见"
    assert "Sys/PaidModel" not in names, "付费系统种子仍不可见"


@pytest.mark.asyncio
async def test_guest_llm_router_resolves_opencode_model(db_session: AsyncSession):
    """匿名用户 LLMRouter 可解析到 OPENCODE 公共模型且不带任何站点 Key。"""
    from app.services.ai_providers.opencode import OPENCODE_PUBLIC_KEY

    guest = await _make_user(db_session, "g-route@guest.local", is_guest=True)
    await _make_model(db_session, None, "Sys/PaidModel")
    oc = await _make_opencode_model(db_session, "OpenCode/ling-3.1-flash", "ling-3.1-flash-free")

    resolution = await LLMRouter.resolve(
        db_session, guest.id, is_guest=True,
    )
    assert resolution.provider == "OPENCODE"
    assert resolution.model_id == oc.model_id
    # 匿名通道固定 Bearer public，不会泄露站点 Key
    assert (resolution.api_key or OPENCODE_PUBLIC_KEY) == OPENCODE_PUBLIC_KEY


@pytest.mark.asyncio
async def test_guest_llm_router_skips_paid_system_seed(db_session: AsyncSession):
    """库里只有付费系统种子时，匿名用户仍应报无可用模型而不是借用付费 Key。"""
    from app.services.ai_providers.factory import AIProviderFactory
    from app.services.ai_providers.base import AIProviderConfig

    guest = await _make_user(db_session, "g-paid@guest.local", is_guest=True)
    await _make_model(db_session, None, "Sys/PaidOnly")

    with pytest.raises(NoAvailableModelError):
        await LLMRouter.resolve(db_session, guest.id, is_guest=True)

    # 且工厂不会为 OPENCODE 以外的系统种子创建可用 provider 泄露 Key
    provider = AIProviderFactory.create("OPENCODE", AIProviderConfig())
    assert provider._resolve_api_key(None) == "public"


@pytest.mark.asyncio
async def test_guest_sees_system_assistants_readonly(db_session: AsyncSession, api):
    """匿名用户可见系统助手（使用模型的必经入口），但不可写。"""
    guest = await _make_user(db_session, "g-asst@guest.local", is_guest=True)
    await _make_assistant(db_session, None, "系统助手")

    async with api(guest) as ac:
        res = await ac.get("/ai/assistants")
    names = {a["name"] for a in res.json()}
    assert "系统助手" in names, "系统助手对匿名用户可见"

    # 只读：匿名用户不能修改系统助手
    result = await db_session.execute(
        select(AIAssistant).where(AIAssistant.name == "系统助手")
    )
    sys_asst = result.scalar_one()
    async with api(guest) as ac:
        res = await ac.put(f"/ai/assistants/{sys_asst.id}", json={"name": "改名"})
    assert res.status_code == 404, "系统助手对匿名用户不可写"
