"""匿名登录功能测试：登录开关、独立账号隔离、功能边界与事件记录。

对应 ``GUEST_LOGIN_ENABLED`` 等五个配置开关，以及 ``app/services/guest_service.py``
与 ``app/services/guest_event_service.py``。

**注意**：测试跑在内存 SQLite 上，而 SQLite **不强制** ``ON DELETE`` 级联规则，
因此这里只断言「清除后目标行确实不存在」，不断言级联行为本身。
"""
from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.models.guest_event import GuestEvent, GuestEventType
from app.models.note.note import Note
from app.models.user import User


async def _make_guest(db: AsyncSession, *, name: str = "匿名用户") -> User:
    """直接构造一条匿名账号（绕过 HTTP，用于隔离/配额等底层测试）。"""
    user = User(
        email=f"guest-{uuid.uuid4().hex}@guest.local",
        password_hash="hash",
        name=name,
        role="guest",
        status="Active",
        is_guest=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


def _make_client(db: AsyncSession, *, user: User | None = None):
    """构建一个覆盖 ``get_db``（可选 ``get_current_user``）的 API client。"""
    from app.auth import get_current_user
    from app.main import app

    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    if user is not None:
        async def override_user():
            return user

        app.dependency_overrides[get_current_user] = override_user

    return app, ASGITransport(app=app)


@pytest.fixture
def raw_client(db_session: AsyncSession):
    """未登录态 client（仅覆盖 get_db）。"""
    app, transport = _make_client(db_session)
    client = AsyncClient(transport=transport, base_url="http://test/api/v1")
    yield client
    app.dependency_overrides.clear()


# ── 登录与开关 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guest_login_creates_user_and_token(raw_client):
    res = await raw_client.post("/auth/guest")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["access_token"] and body["refresh_token"]
    user = body["user"]
    # 原始响应为 snake_case（前端 client.ts 统一转 camelCase）
    assert user["is_guest"] is True
    assert user["role"] == "guest"
    assert user["email"].startswith("guest-") and user["email"].endswith("@guest.local")


@pytest.mark.asyncio
async def test_guest_login_disabled_returns_403(
    raw_client, monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(get_settings(), "GUEST_LOGIN_ENABLED", False)
    res = await raw_client.post("/auth/guest")
    assert res.status_code == 403


@pytest.mark.asyncio
async def test_auth_config_exposes_guest_flag(raw_client):
    body = (await raw_client.get("/auth/config")).json()
    assert body["guest_login_enabled"] is True


@pytest.mark.asyncio
async def test_each_guest_gets_distinct_account(db_session: AsyncSession):
    """每个匿名会话必须是独立账号，否则匿名用户会互相看到对方的笔记。"""
    from app.services.guest_service import GuestService

    a = await GuestService.create_guest(db_session)
    b = await GuestService.create_guest(db_session)
    await db_session.commit()
    assert a.id != b.id
    assert a.email != b.email
    assert a.is_guest is True and b.is_guest is True
    assert a.role == "guest" and b.role == "guest"


@pytest.mark.asyncio
async def test_guest_cannot_login_with_password(db_session: AsyncSession):
    """匿名账号的密码哈希是随机串，永远无法通过密码登录命中。"""
    from app.services.auth_service import AuthService
    from app.services.guest_service import GuestService

    user = await GuestService.create_guest(db_session)
    await db_session.commit()
    assert await AuthService.authenticate(db_session, user.email, "password") is None
    assert await AuthService.authenticate(db_session, user.email, "") is None


# ── 登录信息事件记录 ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guest_login_writes_login_event(db_session: AsyncSession):
    app, transport = _make_client(db_session)
    async with AsyncClient(
        transport=transport, base_url="http://test/api/v1",
        headers={"X-Forwarded-For": "203.0.113.7, 10.0.0.1", "User-Agent": "pytest-agent"},
    ) as ac:
        res = await ac.post("/auth/guest")
    app.dependency_overrides.clear()

    assert res.status_code == 200
    guest_id = uuid.UUID(res.json()["user"]["id"])

    events = (
        await db_session.execute(
            select(GuestEvent).where(
                GuestEvent.guest_id == guest_id, GuestEvent.event_type == "login",
            )
        )
    ).scalars().all()
    assert len(events) == 1
    # X-Forwarded-For 只取第一段（客户端伪造尾部无效）
    assert events[0].ip_address == "203.0.113.7"
    assert events[0].user_agent == "pytest-agent"


@pytest.mark.asyncio
async def test_events_never_contain_user_content(db_session: AsyncSession):
    """隐私边界：事件表不得出现笔记标题/正文。"""
    from app.services.guest_event_service import GuestEventService

    guest = await _make_guest(db_session)
    secret_title = "绝密项目Alpha"
    note = Note(
        note_no="EVT-1", title=secret_title, note_type="markdown",
        content={"text": "机密正文内容"}, created_by=guest.id,
    )
    db_session.add(note)
    await db_session.commit()

    await GuestEventService.record(
        db_session,
        guest_id=guest.id,
        event_type=GuestEventType.BLOCKED,
        detail="feature_not_allowed",
    )
    rows = (
        await db_session.execute(select(GuestEvent).where(GuestEvent.guest_id == guest.id))
    ).scalars().all()
    assert rows
    for row in rows:
        blob = " ".join(filter(None, [row.detail or "", row.user_agent or ""]))
        assert secret_title not in blob
        assert "机密正文" not in blob
    # detail 只允许固定枚举值
    assert rows[-1].detail == "feature_not_allowed"


@pytest.mark.asyncio
async def test_events_disabled_skips_write(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch):
    from app.services.guest_event_service import GuestEventService

    monkeypatch.setattr(get_settings(), "GUEST_EVENTS_ENABLED", False)
    guest = await _make_guest(db_session)
    await GuestEventService.record(
        db_session, guest_id=guest.id, event_type=GuestEventType.LOGIN,
    )
    count = (
        await db_session.execute(
            select(GuestEvent).where(GuestEvent.guest_id == guest.id)
        )
    ).scalars().all()
    assert count == []


# ── 功能边界 ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_guest_blocked_features_return_403(db_session: AsyncSession):
    """录音与访问令牌对匿名账号禁用，并记录 blocked 事件。"""
    guest = await _make_guest(db_session)
    app, transport = _make_client(db_session, user=guest)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        tokens = await ac.post("/api-tokens", json={"name": "pat"})
        assert tokens.status_code == 403, tokens.text
        share_search = await ac.get("/users/search", params={"q": "a"})
        assert share_search.status_code == 403
    app.dependency_overrides.clear()

    blocked = (
        await db_session.execute(
            select(GuestEvent).where(
                GuestEvent.guest_id == guest.id, GuestEvent.event_type == "blocked",
            )
        )
    ).scalars().all()
    assert len(blocked) >= 2
    assert all(e.detail for e in blocked)


@pytest.mark.asyncio
async def test_regular_user_unaffected_by_guest_gating(db_session: AsyncSession):
    """普通用户仍可使用访问令牌 —— 门控不能误伤正式账号。"""
    import bcrypt

    user = User(
        email="normal@test.com",
        password_hash=bcrypt.hashpw(b"pw123456", bcrypt.gensalt(12)).decode(),
        name="Normal", role="user", status="Active",
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    app, transport = _make_client(db_session, user=user)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        res = await ac.post("/api-tokens", json={"name": "pat"})
    app.dependency_overrides.clear()
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_guest_can_create_note(db_session: AsyncSession):
    """笔记功能对匿名账号全功能放行（零改动即可用）。"""
    guest = await _make_guest(db_session)
    app, transport = _make_client(db_session, user=guest)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        res = await ac.post(
            "/notes", json={"title": "匿名笔记", "note_type": "markdown", "content": {"text": "hi"}},
        )
    app.dependency_overrides.clear()
    assert res.status_code == 201, res.text


@pytest.mark.asyncio
async def test_two_guests_are_isolated(db_session: AsyncSession):
    """核心隐私断言：A 看不到 B 的笔记。"""
    from app.services.note.note_service import NoteService

    guest_a = await _make_guest(db_session, name="A")
    guest_b = await _make_guest(db_session, name="B")
    for owner, title in ((guest_a, "A的笔记"), (guest_b, "B的笔记")):
        db_session.add(Note(
            note_no=f"ISO-{uuid.uuid4().hex[:8]}",
            title=title, note_type="markdown",
            content={"text": "x"}, created_by=owner.id,
        ))
    await db_session.commit()

    a_notes, a_total = await NoteService.list_notes(db_session, user_id=guest_a.id)
    b_notes, b_total = await NoteService.list_notes(db_session, user_id=guest_b.id)
    assert a_total == 1 and b_total == 1
    assert [n.title for n in a_notes] == ["A的笔记"]
    assert [n.title for n in b_notes] == ["B的笔记"]


# ── 笔记配额按用户类型区分 ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_guest_quota_is_independent(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
):
    import bcrypt

    settings = get_settings()
    monkeypatch.setattr(settings, "GUEST_MAX_NOTES", 2)
    monkeypatch.setattr(settings, "USER_MAX_NOTES", 10)

    guest = await _make_guest(db_session)
    regular = User(
        email="quota-normal@test.com",
        password_hash=bcrypt.hashpw(b"pw123456", bcrypt.gensalt(12)).decode(),
        name="Normal", role="user", status="Active",
    )
    db_session.add(regular)
    await db_session.commit()
    await db_session.refresh(regular)

    from app.services.note.note_service import NoteService

    for i in range(2):
        await NoteService.create_note(db_session, {
            "note_no": f"GQ-{uuid.uuid4().hex[:8]}", "title": f"g{i}",
            "note_type": "markdown", "content": {"text": "x"}, "created_by": guest.id,
        })
    from app.exceptions import BadRequestException

    with pytest.raises(BadRequestException, match="上限"):
        await NoteService.create_note(db_session, {
            "note_no": f"GQ-{uuid.uuid4().hex[:8]}", "title": "g2",
            "note_type": "markdown", "content": {"text": "x"}, "created_by": guest.id,
        })

    # 普通用户不受匿名配额影响
    await NoteService.create_note(db_session, {
        "note_no": f"NQ-{uuid.uuid4().hex[:8]}", "title": "n1",
        "note_type": "markdown", "content": {"text": "x"}, "created_by": regular.id,
    })
