"""PAT 权限范围：签发、认证后挂载、写操作拦截。"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.auth import require_write_scope, token_scopes
from app.models.user import User
from app.services.api_token_service import ApiTokenService


@pytest.mark.asyncio
async def test_token_scopes_are_attached_after_authentication(db_session, test_user):
    _token, raw = await ApiTokenService.create_token(
        db_session, test_user.id, "readonly", scopes="read",
    )
    user = await ApiTokenService.authenticate(db_session, raw)
    assert user is not None
    assert token_scopes(user) == {"read"}
    with pytest.raises(HTTPException) as exc:
        await require_write_scope(user)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_write_token_allows_write(db_session, test_user):
    _token, raw = await ApiTokenService.create_token(
        db_session, test_user.id, "writer", scopes="read,write",
    )
    user = await ApiTokenService.authenticate(db_session, raw)
    assert user is not None
    assert token_scopes(user) == {"read", "write"}
    assert await require_write_scope(user) is user


@pytest.mark.asyncio
async def test_interactive_user_has_full_access():
    user = User(email="interactive@test.com", password_hash="hash", name="UI")
    assert token_scopes(user) is None
    assert await require_write_scope(user) is user


@pytest.mark.asyncio
async def test_revoked_token_cannot_authenticate(db_session, test_user):
    token, raw = await ApiTokenService.create_token(db_session, test_user.id, "revoked")
    await ApiTokenService.revoke_token(db_session, test_user.id, token.id)
    assert await ApiTokenService.authenticate(db_session, raw) is None
