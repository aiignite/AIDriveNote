"""Smoke tests for auth login/register (catches missing imports)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.email_verification import EmailVerificationCode
from app.models.user import User
from app.services.email_service import EmailService


async def _create_user(db: AsyncSession, email: str, password: str = "secret123") -> User:
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt(12)).decode()
    user = User(email=email, password_hash=hashed, name="Auth Test")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest_asyncio.fixture
async def auth_client(db_session: AsyncSession):
    from app.main import app

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_login_wrong_password_returns_401(auth_client: AsyncClient, db_session: AsyncSession):
    await _create_user(db_session, "login@test.com")
    res = await auth_client.post(
        "/auth/login",
        json={"email": "login@test.com", "password": "wrong"},
    )
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_login_success(auth_client: AsyncClient, db_session: AsyncSession):
    await _create_user(db_session, "ok@test.com", "MyPass123")
    res = await auth_client.post(
        "/auth/login",
        json={"email": "ok@test.com", "password": "MyPass123"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["access_token"]
    assert data["refresh_token"]
    # 登录响应直接携带用户信息，前端无需再请求 /auth/me
    assert data["user"]["email"] == "ok@test.com"


# ── 注册验证码流程（三步式） ──────────────────────────────────


@pytest.fixture
def sent_codes(monkeypatch):
    """拦截验证码邮件发送，记录明文验证码供断言使用。"""
    codes: list[dict] = []

    async def _fake_send(*, email: str, code: str, ttl_minutes: int) -> None:
        codes.append({"email": email, "code": code, "ttl": ttl_minutes})

    monkeypatch.setattr(EmailService, "send_verification_code", staticmethod(_fake_send))
    return codes


def _wrong_code(code: str) -> str:
    return "999999" if code != "999999" else "888888"


async def _latest_code_record(db: AsyncSession) -> EmailVerificationCode:
    result = await db.execute(
        select(EmailVerificationCode).order_by(EmailVerificationCode.created_at.desc())
    )
    return result.scalars().first()


@pytest.mark.asyncio
async def test_register_full_flow(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    res = await auth_client.post(
        "/auth/register/request", json={"email": "New@Test.com", "name": "New User"},
    )
    assert res.status_code == 200
    # 邮箱归一化 + 创建 Pending 占位用户
    assert sent_codes[-1]["email"] == "new@test.com"
    pending = (
        await db_session.execute(select(User).where(User.email == "new@test.com"))
    ).scalar_one()
    assert pending.status == "Pending"

    code = sent_codes[-1]["code"]
    # 第二步：独立验码不消费
    res = await auth_client.post(
        "/auth/register/verify-code", json={"email": "new@test.com", "code": code},
    )
    assert res.status_code == 200

    # 第三步：完成注册并激活
    res = await auth_client.post(
        "/auth/register/complete",
        json={"email": "new@test.com", "code": code, "new_password": "MyPass123"},
    )
    assert res.status_code == 200
    assert res.json()["status"] == "Active"

    # 验证码一次性：消费后同码不可再用
    res = await auth_client.post(
        "/auth/register/verify-code", json={"email": "new@test.com", "code": code},
    )
    assert res.status_code == 400

    # 注册完成即可登录
    res = await auth_client.post(
        "/auth/login", json={"email": "new@test.com", "password": "MyPass123"},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_register_request_rejected_for_active_email(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    await _create_user(db_session, "taken@test.com", "MyPass123")
    res = await auth_client.post(
        "/auth/register/request", json={"email": "taken@test.com", "name": "Taken"},
    )
    assert res.status_code == 409
    assert sent_codes == []


@pytest.mark.asyncio
async def test_register_request_cooldown(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    res = await auth_client.post(
        "/auth/register/request", json={"email": "cool@test.com", "name": "Cool"},
    )
    assert res.status_code == 200
    res = await auth_client.post(
        "/auth/register/request", json={"email": "cool@test.com", "name": "Cool"},
    )
    assert res.status_code == 400
    assert len(sent_codes) == 1


@pytest.mark.asyncio
async def test_register_verify_code_wrong(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    await auth_client.post(
        "/auth/register/request", json={"email": "wrong@test.com", "name": "Wrong"},
    )
    code = sent_codes[-1]["code"]
    res = await auth_client.post(
        "/auth/register/verify-code", json={"email": "wrong@test.com", "code": _wrong_code(code)},
    )
    assert res.status_code == 400
    # 错误一次未达上限：正确验证码仍可通过
    res = await auth_client.post(
        "/auth/register/verify-code", json={"email": "wrong@test.com", "code": code},
    )
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_register_verify_code_attempts_limit(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    await auth_client.post(
        "/auth/register/request", json={"email": "retry@test.com", "name": "Retry"},
    )
    code = sent_codes[-1]["code"]
    for _ in range(5):
        res = await auth_client.post(
            "/auth/register/verify-code",
            json={"email": "retry@test.com", "code": _wrong_code(code)},
        )
        assert res.status_code == 400
    # 达到尝试上限后，即使验证码正确也必须重新获取
    res = await auth_client.post(
        "/auth/register/verify-code", json={"email": "retry@test.com", "code": code},
    )
    assert res.status_code == 400
    assert "尝试次数过多" in res.json()["detail"]


@pytest.mark.asyncio
async def test_register_verify_code_expired(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    await auth_client.post(
        "/auth/register/request", json={"email": "stale@test.com", "name": "Stale"},
    )
    code = sent_codes[-1]["code"]
    record = await _latest_code_record(db_session)
    record.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    res = await auth_client.post(
        "/auth/register/verify-code", json={"email": "stale@test.com", "code": code},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_register_complete_without_request(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    res = await auth_client.post(
        "/auth/register/complete",
        json={"email": "ghost@test.com", "code": "123456", "new_password": "MyPass123"},
    )
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_pending_user_cannot_login(
    auth_client: AsyncClient, db_session: AsyncSession, sent_codes: list[dict],
):
    res = await auth_client.post(
        "/auth/register/request", json={"email": "pending@test.com", "name": "Pending"},
    )
    assert res.status_code == 200
    # 占位密码为随机串，任何密码都无法登录 Pending 账号
    res = await auth_client.post(
        "/auth/login", json={"email": "pending@test.com", "password": "whatever123"},
    )
    assert res.status_code == 401
