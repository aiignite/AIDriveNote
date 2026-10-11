"""Tests for admin user management API."""
from __future__ import annotations

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.models.user import User


async def _create_user(
    db: AsyncSession,
    *,
    email: str,
    name: str,
    role: str = "user",
    status: str = "Active",
) -> User:
    hashed = bcrypt.hashpw(b"test_password", bcrypt.gensalt(12)).decode("utf-8")
    user = User(email=email, password_hash=hashed, name=name, role=role, status=status)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest_asyncio.fixture
async def admin_client(db_session: AsyncSession):
    from app.main import app

    admin = await _create_user(db_session, email="admin@test.com", name="Admin", role="admin")

    async def override_get_db():
        yield db_session

    async def override_user():
        return admin

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac, admin

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def user_client(db_session: AsyncSession):
    from app.main import app

    user = await _create_user(db_session, email="user@test.com", name="Regular")

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


@pytest.mark.asyncio
async def test_non_admin_forbidden(user_client):
    client, _user = user_client
    res = await client.get("/admin/users")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_admin_list_users(admin_client, db_session: AsyncSession):
    client, _admin = admin_client
    await _create_user(db_session, email="alice@test.com", name="Alice")
    await _create_user(db_session, email="bob@test.com", name="Bob", role="admin")

    res = await client.get("/admin/users")
    assert res.status_code == 200
    data = res.json()
    assert data["total"] >= 3
    assert len(data["items"]) >= 3


@pytest.mark.asyncio
async def test_admin_search_and_filter(admin_client, db_session: AsyncSession):
    client, _admin = admin_client
    await _create_user(db_session, email="findme@test.com", name="FindMe", status="Inactive")

    res = await client.get("/admin/users", params={"q": "findme"})
    assert res.status_code == 200
    items = res.json()["items"]
    assert any(u["email"] == "findme@test.com" for u in items)

    res = await client.get("/admin/users", params={"status": "Inactive"})
    assert res.status_code == 200
    assert all(u["status"] == "Inactive" for u in res.json()["items"])


@pytest.mark.asyncio
async def test_admin_update_user(admin_client, db_session: AsyncSession):
    client, _admin = admin_client
    target = await _create_user(db_session, email="target@test.com", name="Old Name")

    res = await client.patch(
        f"/admin/users/{target.id}",
        json={"name": "New Name", "status": "Inactive", "role": "user"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "New Name"
    assert data["status"] == "Inactive"


@pytest.mark.asyncio
async def test_admin_cannot_deactivate_self(admin_client):
    client, admin = admin_client
    res = await client.patch(
        f"/admin/users/{admin.id}",
        json={"status": "Inactive"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_admin_cannot_demote_self(admin_client):
    client, admin = admin_client
    res = await client.patch(
        f"/admin/users/{admin.id}",
        json={"role": "user"},
    )
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_cannot_demote_last_admin(admin_client, db_session: AsyncSession):
    client, admin = admin_client
    res = await client.patch(
        f"/admin/users/{admin.id}",
        json={"role": "user"},
    )
    assert res.status_code == 403

    other = await _create_user(db_session, email="other-admin@test.com", name="Other", role="admin")
    res = await client.patch(
        f"/admin/users/{other.id}",
        json={"role": "user"},
    )
    assert res.status_code == 200
    assert res.json()["role"] == "user"


@pytest.mark.asyncio
async def test_invalid_status_rejected(admin_client, db_session: AsyncSession):
    client, _admin = admin_client
    target = await _create_user(db_session, email="bad@test.com", name="Bad")
    res = await client.patch(
        f"/admin/users/{target.id}",
        json={"status": "Banned"},
    )
    assert res.status_code == 400


# ── 删除用户 ─────────────────────────────────────────────────


@pytest.fixture
def no_email_send(monkeypatch):
    """拦截验证码邮件发送（删除后重新注册用例需要）。"""
    from app.services.email_service import EmailService

    async def _fake_send(*, email: str, code: str, ttl_minutes: int) -> None:
        return None

    monkeypatch.setattr(EmailService, "send_verification_code", staticmethod(_fake_send))


@pytest.mark.asyncio
async def test_admin_delete_user_soft_deletes(admin_client, db_session: AsyncSession):
    client, _admin = admin_client
    target = await _create_user(db_session, email="doomed@test.com", name="Doomed")

    res = await client.delete(f"/admin/users/{target.id}")
    assert res.status_code == 200
    assert res.json() == {"ok": True}

    await db_session.refresh(target)
    assert target.is_deleted is True
    assert target.status == "Inactive"
    # 邮箱改写释放唯一约束，且保留审计痕迹
    assert ".deleted." in target.email
    assert target.email.endswith("@test.com")
    assert target.email != "doomed@test.com"

    # 列表不再出现
    res = await client.get("/admin/users")
    assert all(u["email"] != "doomed@test.com" for u in res.json()["items"])

    # 再删除返回 404
    res = await client.delete(f"/admin/users/{target.id}")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_delete_user_revokes_api_tokens(admin_client, db_session: AsyncSession):
    from app.models.api_token import UserApiToken

    client, _admin = admin_client
    target = await _create_user(db_session, email="tokener@test.com", name="Tokener")
    token = UserApiToken(
        user_id=target.id, name="agent", token_hash="a" * 64, token_prefix="abcd",
    )
    db_session.add(token)
    await db_session.commit()

    res = await client.delete(f"/admin/users/{target.id}")
    assert res.status_code == 200
    await db_session.refresh(token)
    assert token.is_revoked is True


@pytest.mark.asyncio
async def test_admin_cannot_delete_self(admin_client):
    client, admin = admin_client
    res = await client.delete(f"/admin/users/{admin.id}")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_deleted_user_cannot_login(admin_client, db_session: AsyncSession):
    client, _admin = admin_client
    target = await _create_user(db_session, email="goner@test.com", name="Goner")

    res = await client.post(
        "/auth/login", json={"email": "goner@test.com", "password": "test_password"},
    )
    assert res.status_code == 200

    await client.delete(f"/admin/users/{target.id}")
    res = await client.post(
        "/auth/login", json={"email": "goner@test.com", "password": "test_password"},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_freed_email_can_register_again(
    admin_client, db_session: AsyncSession, no_email_send,
):
    client, _admin = admin_client
    target = await _create_user(db_session, email="recycle@test.com", name="Recycle")
    await client.delete(f"/admin/users/{target.id}")

    # 原邮箱重新走注册发码（邮箱唯一约束已释放）
    res = await client.post(
        "/auth/register/request", json={"email": "recycle@test.com", "name": "Recycle"},
    )
    assert res.status_code == 200

    from sqlalchemy import select

    from app.models.user import User as UserModel

    pending = (
        await db_session.execute(
            select(UserModel).where(UserModel.email == "recycle@test.com"),
        )
    ).scalar_one()
    assert pending.status == "Pending"
