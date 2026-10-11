"""公网测试部署防护测试：注册开关、SSO 建号、单用户配额与上传体积上限。

对应 settings 中的 ``SELF_REGISTRATION_ENABLED`` / ``SSO_AUTO_CREATE_USERS`` /
``USER_MAX_NOTES`` / ``USER_MAX_UPLOAD_BYTES`` 四个防护开关，保证发布到公网
后陌生账号进不来、单个测试用户占用的存储有上界。
"""
from __future__ import annotations

import uuid

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.exceptions import BadRequestException, ForbiddenException
from app.models.user import User
from app.services.ai.attachment_service import AttachmentService
from app.services.note.note_asset_service import MAX_IMAGE_BYTES, NoteAssetService
from app.services.sso_service import SSOService


async def _create_user(db: AsyncSession, *, email: str, name: str = "Tester") -> User:
    hashed = bcrypt.hashpw(b"test_password", bcrypt.gensalt(12)).decode("utf-8")
    user = User(email=email, password_hash=hashed, name=name)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest_asyncio.fixture
async def api_client(db_session: AsyncSession):
    """带登录态的 API client（get_current_user 直接返回测试用户）。"""
    from app.auth import get_current_user
    from app.main import app

    user = await _create_user(db_session, email="quota@test.com")

    async def override_get_db():
        yield db_session

    async def override_user():
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac, user

    app.dependency_overrides.clear()


# ── 注册开关 ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_auth_config_exposes_registration_flag(api_client: tuple[AsyncClient, User]):
    client, _user = api_client
    res = await client.get("/auth/config")
    assert res.status_code == 200
    # 默认开启（本地开发 / 测试环境保持原行为）
    assert res.json()["registration_enabled"] is True


@pytest.mark.asyncio
async def test_registration_disabled_blocks_register_flow(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
):
    settings = get_settings()
    monkeypatch.setattr(settings, "SELF_REGISTRATION_ENABLED", False)

    from app.main import app

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        config = await ac.get("/auth/config")
        assert config.json()["registration_enabled"] is False

        # 三步注册流程全部被 403 拦截，且不创建占位用户
        res = await ac.post(
            "/auth/register/request", json={"email": "stranger@test.com", "name": "S"},
        )
        assert res.status_code == 403
        res = await ac.post(
            "/auth/register/verify-code", json={"email": "stranger@test.com", "code": "123456"},
        )
        assert res.status_code == 403
        res = await ac.post(
            "/auth/register/complete",
            json={"email": "stranger@test.com", "code": "123456", "new_password": "x123456"},
        )
        assert res.status_code == 403

        from sqlalchemy import select

        from app.models.user import User as UserModel

        remaining = (
            await db_session.execute(
                select(UserModel).where(UserModel.email == "stranger@test.com")
            )
        ).scalar_one_or_none()
        assert remaining is None
    app.dependency_overrides.clear()


# ── SSO 建号开关 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sso_auto_create_disabled_rejects_stranger(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(get_settings(), "SSO_AUTO_CREATE_USERS", False)
    claims = {"email": "stranger@portal.com", "name": "Stranger", "role": "user"}
    with pytest.raises(ForbiddenException):
        await SSOService.sync_user_from_claims(db_session, claims)


@pytest.mark.asyncio
async def test_sso_auto_create_enabled_creates_user(db_session: AsyncSession):
    claims = {"email": "fresh@portal.com", "name": "Fresh", "role": "user"}
    user, created = await SSOService.sync_user_from_claims(db_session, claims)
    assert created is True
    assert user.email == "fresh@portal.com"


# ── 单用户笔记数量上限 ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_note_quota_including_trash(
    api_client: tuple[AsyncClient, User], monkeypatch: pytest.MonkeyPatch,
):
    client, user = api_client
    monkeypatch.setattr(get_settings(), "USER_MAX_NOTES", 3)

    ids: list[str] = []
    for i in range(3):
        res = await client.post(
            "/notes", json={"title": f"N{i}", "note_type": "markdown", "content": {"text": "x"}},
        )
        assert res.status_code == 201, res.text
        ids.append(res.json()["id"])

    # 第 4 篇被拒
    res = await client.post(
        "/notes", json={"title": "overflow", "note_type": "markdown"},
    )
    assert res.status_code == 400
    assert "上限" in res.json()["detail"]

    # 删除（进回收站）后仍计入配额：回收站不清位
    res = await client.delete(f"/notes/{ids[0]}")
    assert res.status_code == 204
    res = await client.post(
        "/notes", json={"title": "still-over", "note_type": "markdown"},
    )
    assert res.status_code == 400

    # 永久删除后才释放名额
    res = await client.delete(f"/notes/{ids[0]}/permanent")
    assert res.status_code == 204
    res = await client.post(
        "/notes", json={"title": "fits-again", "note_type": "markdown"},
    )
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_note_list_limit_is_capped(api_client: tuple[AsyncClient, User]):
    client, _user = api_client
    res = await client.get("/notes", params={"limit": 100000})
    assert res.status_code == 422


# ── 上传体积上限 ─────────────────────────────────────────────────────


def test_asset_limit_matches_settings() -> None:
    assert MAX_IMAGE_BYTES == get_settings().USER_MAX_UPLOAD_BYTES == 2 * 1024 * 1024


@pytest.mark.asyncio
async def test_store_image_rejects_oversize(db_session: AsyncSession):
    payload = b"x" * (get_settings().USER_MAX_UPLOAD_BYTES + 1)
    with pytest.raises(BadRequestException):
        await NoteAssetService.store_image(db_session, uuid.uuid4(), payload, "image/png")


@pytest.mark.asyncio
async def test_attachment_rejects_oversize(db_session: AsyncSession):
    user = await _create_user(db_session, email="attach@test.com")

    class _FakeUpload:
        filename = "big.pdf"
        content_type = "application/pdf"

        async def read(self) -> bytes:
            return b"x" * (get_settings().USER_MAX_UPLOAD_BYTES + 1)

    with pytest.raises(ValueError, match="文件过大"):
        await AttachmentService.upload(db_session, user.id, _FakeUpload())  # type: ignore[arg-type]
