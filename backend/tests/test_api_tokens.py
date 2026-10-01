"""个人访问令牌（PAT）与笔记追加端点测试。"""
from __future__ import annotations

import pytest

from app.services.api_token_service import ApiTokenService
from app.services.auth_service import AuthService


def _jwt_headers(user) -> dict[str, str]:
    """构造交互式登录会话的请求头。

    @param user 用户对象
    @returns Authorization 请求头
    """
    access_token, _ = AuthService.create_access_token(user.id)
    return {"Authorization": f"Bearer {access_token}"}


@pytest.mark.asyncio
async def test_token_lifecycle(client, test_user):
    """签发后可用令牌鉴权，撤销后立即失效，且列表不泄露明文。"""
    headers = _jwt_headers(test_user)

    created = await client.post(
        "/api/v1/api-tokens", json={"name": "Claude Desktop"}, headers=headers,
    )
    assert created.status_code == 201, created.text
    payload = created.json()
    raw = payload["token"]
    assert raw.startswith(ApiTokenService.TOKEN_PREFIX)

    me = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw}"})
    assert me.status_code == 200
    assert me.json()["email"] == test_user.email

    listed = await client.get("/api/v1/api-tokens", headers=headers)
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) == 1
    assert items[0]["token_prefix"] == raw[: ApiTokenService.DISPLAY_PREFIX_LEN]
    assert "token" not in items[0]

    revoked = await client.delete(f"/api/v1/api-tokens/{payload['id']}", headers=headers)
    assert revoked.status_code == 204

    after = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {raw}"})
    assert after.status_code == 401


@pytest.mark.asyncio
async def test_token_cannot_manage_tokens(client, db_session, test_user):
    """访问令牌不能用于签发新的访问令牌，但普通接口仍可用。"""
    _, raw = await ApiTokenService.create_token(db_session, test_user.id, "agent")
    headers = {"Authorization": f"Bearer {raw}"}

    resp = await client.post("/api/v1/api-tokens", json={"name": "escalate"}, headers=headers)
    assert resp.status_code == 401

    assert (await client.get("/api/v1/auth/me", headers=headers)).status_code == 200


@pytest.mark.asyncio
async def test_append_concatenates_markdown(client, db_session, test_user):
    """追加端点应拼接 Markdown 正文并生成修订记录。"""
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "MCP 追加测试",
        "note_type": "markdown",
        "status": "Active",
        "content": {"text": "第一段"},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    _, raw = await ApiTokenService.create_token(db_session, test_user.id, "agent")
    headers = {"Authorization": f"Bearer {raw}"}

    resp = await client.post(
        f"/api/v1/notes/{note.id}/append", json={"text": "第二段"}, headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["content"]["text"] == "第一段\n\n第二段"

    revisions = await client.get(f"/api/v1/notes/{note.id}/revisions", headers=headers)
    assert revisions.status_code == 200
    assert len(revisions.json()) >= 1


@pytest.mark.asyncio
async def test_append_rejects_unsupported_type(client, db_session, test_user):
    """思维导图等类型不支持追加文本，应返回 400。"""
    from app.services.note.note_service import NoteService

    note = await NoteService.create_note(db_session, {
        "title": "导图追加测试",
        "note_type": "mindmap",
        "content": {"data": {"text": "根"}, "children": []},
        "created_by": test_user.id,
        "updated_by": test_user.id,
    })
    _, raw = await ApiTokenService.create_token(db_session, test_user.id, "agent")

    resp = await client.post(
        f"/api/v1/notes/{note.id}/append",
        json={"text": "追加"},
        headers={"Authorization": f"Bearer {raw}"},
    )
    assert resp.status_code == 400