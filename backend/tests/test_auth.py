"""Smoke tests for auth login/register (catches missing imports)."""
from __future__ import annotations

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User


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
