"""Tests for note / folder encryption (加密文档 / 加密文件夹).

覆盖范围：
- 密钥派生与正文加解密往返；
- 解锁票据的签发 / 解析 / 归属校验；
- 笔记级加解密（含明文衍生数据清理）；
- 文件夹子树批量加解密与保护范围优先级；
- 路由层：锁定脱敏、解锁读取、跨保护域移动被拒、复制被拒。
"""
from __future__ import annotations

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.models.note.note import Note, NoteFolder, NoteRevision
from app.models.user import User
from app.services.note import note_crypto
from app.services.note import note_lock_service
from app.services.note.note_lock_service import NoteLockService
from app.services.note.note_service import NoteFolderService, NoteService

# ── 通用辅助 ──────────────────────────────────────────

PLAIN_CONTENT = {"text": "绝密内容 secret-42"}


@pytest_asyncio.fixture(autouse=True)
async def _reset_throttle():
    """隔离密码失败节流状态，避免跨用例污染。"""
    note_lock_service._failures.clear()
    yield
    note_lock_service._failures.clear()


async def _make_user(db: AsyncSession, email: str, name: str = "Tester") -> User:
    hashed = bcrypt.hashpw(b"test_password", bcrypt.gensalt(12)).decode("utf-8")
    user = User(email=email, password_hash=hashed, name=name)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _make_note(
    db: AsyncSession, user: User, *, title: str = "N", content: dict | None = None,
    folder_id=None,
) -> Note:
    return await NoteService.create_note(db, {
        "title": title,
        "note_type": "markdown",
        "content": content if content is not None else dict(PLAIN_CONTENT),
        "folder_id": folder_id,
        "created_by": user.id,
        "updated_by": user.id,
    })


async def _insert_note(
    db: AsyncSession, user: User, *, title: str = "N", content: dict | None = None,
    folder_id=None,
) -> Note:
    """直接插入 Note 行（跳过检索同步），供路由层测试使用。

    ``NoteService.create_note`` 会触发 ``to_tsvector`` 检索同步，SQLite 下不可用，
    且其 SAVEPOINT 回滚会把会话内对象置为过期；路由测试直接建行以规避。
    """
    import uuid

    note = Note(
        note_no=f"NT2026{uuid.uuid4().hex[:8].upper()}",
        title=title,
        note_type="markdown",
        content=content if content is not None else dict(PLAIN_CONTENT),
        folder_id=folder_id,
        status="Active",
        is_deleted=False,
        created_by=user.id,
        updated_by=user.id,
    )
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


# ── note_crypto 单元测试 ──────────────────────────────

def test_derive_fernet_key_is_deterministic_and_salt_sensitive() -> None:
    salt = note_crypto.new_salt()
    k1 = note_crypto.derive_fernet_key("pw123456", salt)
    k2 = note_crypto.derive_fernet_key("pw123456", salt)
    assert k1 == k2
    # 不同盐 → 不同密钥
    assert k1 != note_crypto.derive_fernet_key("pw123456", note_crypto.new_salt())
    # 不同密码 → 不同密钥
    assert k1 != note_crypto.derive_fernet_key("pw654321", salt)


def test_encrypt_decrypt_content_round_trip() -> None:
    key = note_crypto.derive_fernet_key("pw123456", note_crypto.new_salt())
    wrapped = note_crypto.encrypt_content(PLAIN_CONTENT, key)
    assert note_crypto.is_encrypted_content(wrapped)
    assert note_crypto.ENCRYPTED_CONTENT_KEY in wrapped
    # 明文不应出现在密文中
    assert "secret-42" not in str(wrapped)
    assert note_crypto.decrypt_content(wrapped, key) == PLAIN_CONTENT


def test_encrypt_content_is_idempotent() -> None:
    key = note_crypto.derive_fernet_key("pw123456", note_crypto.new_salt())
    once = note_crypto.encrypt_content(PLAIN_CONTENT, key)
    twice = note_crypto.encrypt_content(once, key)
    assert once == twice


def test_decrypt_content_wrong_key_returns_none() -> None:
    good = note_crypto.derive_fernet_key("pw123456", note_crypto.new_salt())
    bad = note_crypto.derive_fernet_key("other-pw", note_crypto.new_salt())
    wrapped = note_crypto.encrypt_content(PLAIN_CONTENT, good)
    assert note_crypto.decrypt_content(wrapped, bad) is None


def test_decrypt_content_passthrough_for_plaintext() -> None:
    key = note_crypto.derive_fernet_key("pw123456", note_crypto.new_salt())
    assert note_crypto.decrypt_content(PLAIN_CONTENT, key) == PLAIN_CONTENT


# ── 解锁票据 ──────────────────────────────────────────

def test_unlock_token_round_trip() -> None:
    token = note_crypto.make_unlock_token(
        scope="note", target_id="11111111-1111-1111-1111-111111111111",
        user_id="22222222-2222-2222-2222-222222222222", key_b64="KEYDATA",
    )
    payload = note_crypto.parse_unlock_token(token)
    assert payload is not None
    assert payload["scope"] == "note"
    assert payload["key"] == "KEYDATA"
    assert payload["uid"] == "22222222-2222-2222-2222-222222222222"


def test_parse_unlock_token_rejects_garbage_and_expired() -> None:
    assert note_crypto.parse_unlock_token("not-a-token") is None
    assert note_crypto.parse_unlock_token(None) is None
    expired = note_crypto.make_unlock_token(
        scope="note", target_id="a", user_id="b", key_b64="k", ttl=-1,
    )
    assert note_crypto.parse_unlock_token(expired) is None


def test_resolve_key_from_token_validates_scope_and_user() -> None:
    import uuid

    uid = uuid.uuid4()
    target = uuid.uuid4()
    token = note_crypto.make_unlock_token(
        scope="note", target_id=str(target), user_id=str(uid), key_b64="KEY",
    )
    # 匹配
    assert NoteLockService.resolve_key_from_token(("note", target), token, uid) == "KEY"
    # 范围不匹配
    assert NoteLockService.resolve_key_from_token(("folder", target), token, uid) is None
    # 对象不匹配
    assert NoteLockService.resolve_key_from_token(("note", uuid.uuid4()), token, uid) is None
    # 用户不匹配
    assert NoteLockService.resolve_key_from_token(("note", target), token, uuid.uuid4()) is None


# ── 笔记级加解密（服务层） ────────────────────────────

@pytest.mark.asyncio
async def test_encrypt_note_hides_plaintext_and_clears_artifacts(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "enc-note@test.com")
    note = await _make_note(note_db, user)
    # 造一条含明文的修订，验证加密后被清除
    note.search_text = "secret-42 明文检索"
    note_db.add(NoteRevision(
        note_id=note.id, seq=0, title=note.title,
        content_snapshot=dict(PLAIN_CONTENT), changed_by=user.id,
    ))
    await note_db.commit()

    key = await NoteLockService.encrypt_note(note_db, note, "pw123456")

    assert note.is_encrypted is True
    assert note.enc_salt and note.enc_verifier
    assert note_crypto.is_encrypted_content(note.content)
    assert "secret-42" not in str(note.content)
    # 检索字段与修订被清除，防止明文泄漏
    assert note.search_text is None
    assert note.search_vector is None
    assert note.content_embedding is None
    from sqlalchemy import func, select
    remaining = await note_db.execute(
        select(func.count()).select_from(NoteRevision).where(NoteRevision.note_id == note.id)
    )
    assert remaining.scalar_one() == 0
    # 派生密钥可正确解密
    assert note_crypto.decrypt_content(note.content, key) == PLAIN_CONTENT


@pytest.mark.asyncio
async def test_decrypt_note_rejects_wrong_password(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "dec-wrong@test.com")
    note = await _make_note(note_db, user)
    await NoteLockService.encrypt_note(note_db, note, "pw123456")

    assert await NoteLockService.decrypt_note(note_db, note, "wrong-pw") is False
    assert note.is_encrypted is True
    assert note_crypto.is_encrypted_content(note.content)


@pytest.mark.asyncio
async def test_decrypt_note_restores_plaintext(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "dec-ok@test.com")
    note = await _make_note(note_db, user)
    await NoteLockService.encrypt_note(note_db, note, "pw123456")

    assert await NoteLockService.decrypt_note(note_db, note, "pw123456") is True
    assert note.is_encrypted is False
    assert note.enc_salt is None and note.enc_verifier is None
    assert note.content == PLAIN_CONTENT


# ── 保护范围解析 ──────────────────────────────────────

@pytest.mark.asyncio
async def test_resolve_lock_note_self_takes_priority(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "prio@test.com")
    folder = await NoteFolderService.create_folder(note_db, {"name": "F", "user_id": user.id})
    note = await _make_note(note_db, user, folder_id=folder.id)
    await NoteLockService.encrypt_note(note_db, note, "pw123456")
    # 笔记自身加密优先于文件夹
    assert await NoteLockService.resolve_lock(note_db, note) == ("note", note.id)


@pytest.mark.asyncio
async def test_resolve_lock_via_ancestor_folder(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "ancestor@test.com")
    parent = await NoteFolderService.create_folder(note_db, {"name": "P", "user_id": user.id})
    child = await NoteFolderService.create_folder(
        note_db, {"name": "C", "parent_id": parent.id, "user_id": user.id},
    )
    await NoteLockService.encrypt_folder(note_db, parent, "pw123456")
    note = await _make_note(note_db, user, folder_id=child.id)

    # 位于「加密父文件夹 → 子文件夹」的笔记应被父文件夹保护
    assert await NoteLockService.folder_is_locked(note_db, child.id) is True
    assert await NoteLockService.resolve_lock(note_db, note) == ("folder", parent.id)


@pytest.mark.asyncio
async def test_resolve_lock_none_for_plain_note(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "plain@test.com")
    folder = await NoteFolderService.create_folder(note_db, {"name": "F", "user_id": user.id})
    note = await _make_note(note_db, user, folder_id=folder.id)
    assert await NoteLockService.resolve_lock(note_db, note) is None


# ── 文件夹级加解密（服务层） ──────────────────────────

@pytest.mark.asyncio
async def test_encrypt_folder_covers_subtree_and_skips_self_encrypted(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "folder-enc@test.com")
    folder = await NoteFolderService.create_folder(note_db, {"name": "F", "user_id": user.id})
    child = await NoteFolderService.create_folder(
        note_db, {"name": "C", "parent_id": folder.id, "user_id": user.id},
    )
    n1 = await _make_note(note_db, user, title="n1", folder_id=folder.id)
    n2 = await _make_note(note_db, user, title="n2", folder_id=child.id)
    # 自身已加密的笔记保持原样，不被文件夹密钥覆盖
    n3 = await _make_note(note_db, user, title="n3", folder_id=folder.id)
    await NoteLockService.encrypt_note(note_db, n3, "self-pw")
    n3_key = note_crypto.derive_fernet_key("self-pw", n3.enc_salt or "")
    n3_cipher_before = n3.content

    key, affected = await NoteLockService.encrypt_folder(note_db, folder, "folder-pw")

    assert affected == 2  # n1 + n2，不含自身加密的 n3
    for n in (n1, n2):
        assert note_crypto.is_encrypted_content(n.content)
        assert note_crypto.decrypt_content(n.content, key) == PLAIN_CONTENT
    assert folder.is_encrypted is True
    # n3 仍可用自身密码解密，密文未被文件夹密钥改写
    assert n3.content == n3_cipher_before
    assert note_crypto.decrypt_content(n3.content, n3_key) == PLAIN_CONTENT


@pytest.mark.asyncio
async def test_decrypt_folder_restores_subtree(note_db: AsyncSession) -> None:
    user = await _make_user(note_db, "folder-dec@test.com")
    folder = await NoteFolderService.create_folder(note_db, {"name": "F", "user_id": user.id})
    n1 = await _make_note(note_db, user, title="n1", folder_id=folder.id)
    await NoteLockService.encrypt_folder(note_db, folder, "folder-pw")

    assert await NoteLockService.decrypt_folder(note_db, folder, "wrong") == -1
    restored = await NoteLockService.decrypt_folder(note_db, folder, "folder-pw")
    assert restored == 1
    assert folder.is_encrypted is False
    await note_db.refresh(n1)
    assert n1.content == PLAIN_CONTENT


# ── 路由层测试 ────────────────────────────────────────

@pytest_asyncio.fixture
async def lock_client(db_session: AsyncSession):
    """带鉴权覆盖的 API 客户端（返回 client 与当前用户）。"""
    from app.main import app

    user = await _make_user(db_session, "router@test.com")

    async def override_get_db():
        yield db_session

    async def override_user():
        return user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac, user, db_session
    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_router_encrypt_then_locked_and_unlock(lock_client) -> None:
    client, user, db = lock_client
    note = await _insert_note(db, user)

    # 加密
    resp = await client.post(f"/notes/{note.id}/encrypt", json={"password": "pw123456"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["note"]["content"] == PLAIN_CONTENT  # 本次响应返回明文
    token = body["unlock_token"]
    assert token

    # 无票据读取 → 锁定脱敏
    locked = await client.get(f"/notes/{note.id}")
    assert locked.status_code == 200
    lb = locked.json()
    assert lb["is_locked"] is True
    assert lb["is_encrypted"] is True
    assert lb["content"] is None
    assert lb["preview_text"] is None
    assert lb["locked_scope"] == "note"

    # 带票据读取 → 解密返回明文
    unlocked = await client.get(f"/notes/{note.id}", headers={"X-Note-Unlock": token})
    assert unlocked.status_code == 200
    ub = unlocked.json()
    assert ub["is_locked"] is False
    assert ub["content"] == PLAIN_CONTENT


@pytest.mark.asyncio
async def test_router_list_hides_locked_content(lock_client) -> None:
    client, user, db = lock_client
    note = await _insert_note(db, user)
    await client.post(f"/notes/{note.id}/encrypt", json={"password": "pw123456"})

    resp = await client.get("/notes")
    assert resp.status_code == 200
    items = resp.json()["items"]
    target = next(i for i in items if i["id"] == str(note.id))
    assert target["is_locked"] is True
    assert target["content"] is None
    assert target["preview_text"] is None


@pytest.mark.asyncio
async def test_router_unlock_wrong_password_then_correct(lock_client) -> None:
    client, user, db = lock_client
    note = await _insert_note(db, user)
    await client.post(f"/notes/{note.id}/encrypt", json={"password": "pw123456"})

    bad = await client.post(f"/notes/{note.id}/unlock", json={"password": "wrong"})
    assert bad.status_code == 403

    good = await client.post(f"/notes/{note.id}/unlock", json={"password": "pw123456"})
    assert good.status_code == 200
    assert good.json()["unlock_token"]


@pytest.mark.asyncio
async def test_router_patch_locked_note_requires_token(lock_client) -> None:
    client, user, db = lock_client
    note = await _insert_note(db, user)
    await client.post(f"/notes/{note.id}/encrypt", json={"password": "pw123456"})

    # 无票据 → 403
    denied = await client.patch(f"/notes/{note.id}", json={"title": "改名"})
    assert denied.status_code == 403

    # 带票据 → 可改标题并重新加密正文
    token = (await client.post(
        f"/notes/{note.id}/unlock", json={"password": "pw123456"},
    )).json()["unlock_token"]
    new_content = {"text": "updated-密文"}
    ok = await client.patch(
        f"/notes/{note.id}",
        json={"title": "改名", "content": new_content},
        headers={"X-Note-Unlock": token},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["content"] == new_content
    # 落库仍为密文
    await db.refresh(note)
    assert note_crypto.is_encrypted_content(note.content)


@pytest.mark.asyncio
async def test_router_cross_domain_move_rejected(lock_client) -> None:
    client, user, db = lock_client
    folder = await NoteFolderService.create_folder(db, {"name": "Vault", "user_id": user.id})
    note = await _insert_note(db, user, folder_id=folder.id)

    enc = await client.post(f"/notes/folders/{folder.id}/encrypt", json={"password": "pw123456"})
    assert enc.status_code == 200, enc.text
    folder_token = enc.json()["unlock_token"]

    # 试图把受加密文件夹保护的笔记移出该文件夹 → 被拒
    resp = await client.patch(
        f"/notes/{note.id}",
        json={"folder_id": None},
        headers={"X-Note-Unlock": folder_token},
    )
    assert resp.status_code == 400
    assert "取消文件夹加密" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_router_duplicate_encrypted_note_rejected(lock_client) -> None:
    client, user, db = lock_client
    note = await _insert_note(db, user)
    await client.post(f"/notes/{note.id}/encrypt", json={"password": "pw123456"})

    resp = await client.post(f"/notes/{note.id}/duplicate")
    assert resp.status_code == 400
    assert "复制" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_router_folder_encrypt_requires_min_length_password(lock_client) -> None:
    client, user, db = lock_client
    folder = await NoteFolderService.create_folder(db, {"name": "F", "user_id": user.id})
    resp = await client.post(f"/notes/folders/{folder.id}/encrypt", json={"password": "12"})
    assert resp.status_code == 400
