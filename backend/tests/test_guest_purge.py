"""匿名账号数据清除测试：清除顺序、幂等性、资产引用计数与事件留存。

**测试环境注意**：跑在内存 SQLite 上，而 SQLite **不强制** ``ON DELETE`` 级联，
因此这里断言的是「清除后目标行确实不存在」，而非级联语义本身。
清除时统一注入 SQLite 会话，避免依赖真实 Postgres。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai import AISkill, PageSkillBinding
from app.models.guest_event import GuestEvent
from app.models.kb import KbFile, KbRoot
from app.models.knowledge import IngestDocument, IngestJob, KnowledgeCard, NoteSource
from app.models.note.note import Note, NoteFolder, NoteTag
from app.models.user import User
from app.services.guest_purge_service import GuestPurgeService


async def _make_guest(
    db: AsyncSession, *, last_seen_at: datetime | None = None, name: str = "匿名用户",
) -> User:
    user = User(
        email=f"guest-{uuid.uuid4().hex}@guest.local",
        password_hash="hash",
        name=name,
        role="guest",
        status="Active",
        is_guest=True,
        last_seen_at=last_seen_at or datetime.now(timezone.utc),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _make_regular(db: AsyncSession, email: str = "real@test.com") -> User:
    user = User(email=email, password_hash="hash", name="Real", role="user", status="Active")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


def _add_note(db_owner: User, db: AsyncSession, *, title: str, content: dict | None = None) -> Note:
    note = Note(
        note_no=f"PU-{uuid.uuid4().hex[:10]}",
        title=title,
        note_type="markdown",
        content=content or {"text": "x"},
        created_by=db_owner.id,
    )
    db.add(note)
    return note


# ── 核心：清除后数据与账号行都不复存在 ─────────────────────────────


@pytest.mark.asyncio
async def test_purge_removes_guest_data_and_user_row(db_session: AsyncSession):
    guest = await _make_guest(db_session)
    folder = NoteFolder(name="访客文件夹", user_id=guest.id)
    tag = NoteTag(name="访客标签", user_id=guest.id)
    db_session.add_all([folder, tag, _add_note(guest, db_session, title="访客笔记")])
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    assert (await db_session.execute(
        select(func.count()).select_from(User).where(User.id == guest.id)
    )).scalar() == 0, "账号行必须被物理删除"
    # created_by 为 NULL 的笔记会被所有人看到，因此必须确保不残留
    assert (await db_session.execute(
        select(func.count()).select_from(Note).where(Note.created_by == guest.id)
    )).scalar() == 0
    assert (await db_session.execute(
        select(func.count()).select_from(NoteFolder).where(NoteFolder.user_id == guest.id)
    )).scalar() == 0
    assert (await db_session.execute(
        select(func.count()).select_from(NoteTag).where(NoteTag.user_id == guest.id)
    )).scalar() == 0


@pytest.mark.asyncio
async def test_purge_keeps_other_users_data(db_session: AsyncSession):
    guest = await _make_guest(db_session)
    real = await _make_regular(db_session)
    db_session.add_all([_add_note(guest, db_session, title="访客笔记"), _add_note(real, db_session, title="正式笔记")])
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    remaining = (await db_session.execute(select(Note.title))).scalars().all()
    assert remaining == ["正式笔记"]


@pytest.mark.asyncio
async def test_purge_is_idempotent(db_session: AsyncSession):
    """重复清除同一账号不得报错（定时任务与手动触发可能撞车）。"""
    guest = await _make_guest(db_session)
    db_session.add(_add_note(guest, db_session, title="访客笔记"))
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)
    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)
    assert (await db_session.execute(
        select(func.count()).select_from(User).where(User.id == guest.id)
    )).scalar() == 0


@pytest.mark.asyncio
async def test_purge_refuses_non_guest_user(db_session: AsyncSession):
    """正式账号绝不能被匿名清除任务误删。"""
    real = await _make_regular(db_session)
    db_session.add(_add_note(real, db_session, title="正式笔记"))
    await db_session.commit()

    await GuestPurgeService.purge_guest(real.id, reason="manual", db=db_session)

    assert (await db_session.execute(
        select(func.count()).select_from(User).where(User.id == real.id)
    )).scalar() == 1


# ── 超时判定 ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_find_offline_guests_respects_idle_window(db_session: AsyncSession):
    now = datetime.now(timezone.utc)
    stale = await _make_guest(db_session, last_seen_at=now - timedelta(hours=3))
    recently_active = await _make_guest(db_session, last_seen_at=now - timedelta(hours=1))
    active = await _make_guest(db_session, last_seen_at=now)
    never_seen = await _make_guest(db_session)
    never_seen.last_seen_at = None
    real = await _make_regular(db_session)

    found = {u.id for u in await GuestPurgeService.find_offline_guests(db_session)}

    assert stale.id in found, "超过 2 小时未活动的应被选中"
    assert never_seen.id in found, "从未收到请求的应被选中"
    assert recently_active.id not in found, "1 小时前活动过的不应被清除"
    assert active.id not in found, "仍在活动的不应被清除"
    assert real.id not in found, "正式账号永远不应进入清除名单"


@pytest.mark.asyncio
async def test_purged_guest_is_skipped_on_next_scan(db_session: AsyncSession):
    """guest_purged_at 标记后不再重复清除。"""
    guest = await _make_guest(db_session, last_seen_at=datetime.now(timezone.utc) - timedelta(hours=5))
    guest.guest_purged_at = datetime.now(timezone.utc)
    db_session.add(guest)
    await db_session.commit()

    found = {u.id for u in await GuestPurgeService.find_offline_guests(db_session)}
    assert guest.id not in found


# ── 图片资产引用计数 ───────────────────────────────────────────────


def test_find_asset_hashes_recurses_content():
    from app.services.note.note_asset_service import NoteAssetService

    h1 = "a" * 64
    h2 = "b" * 64
    content = {
        "blocks": [
            {"type": "image", "props": {"url": f"/api/v1/notes/assets/{h1}.png"}},
            {"nested": {"deeper": [f"https://x/api/v1/notes/assets/{h2}.jpg"]}},
        ],
    }
    assert NoteAssetService.find_asset_hashes(content) == {h1, h2}
    assert NoteAssetService.find_asset_hashes(None) == set()


def test_delete_asset_rejects_illegal_names():
    """删除函数必须防路径穿越。"""
    from app.exceptions import BadRequestException
    from app.services.note.note_asset_service import NoteAssetService

    with pytest.raises(BadRequestException):
        NoteAssetService.delete_asset("../../etc/passwd", "png")
    with pytest.raises(BadRequestException):
        NoteAssetService.delete_asset("a" * 64, "../../x")


@pytest.mark.asyncio
async def test_shared_asset_survives_purge_of_one_guest(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch,
):
    """两个用户引用同一张图时，清除其中一个不得删掉磁盘文件。"""
    guest = await _make_guest(db_session)
    real = await _make_regular(db_session)
    shared = "c" * 64
    url = f"/api/v1/notes/assets/{shared}.png"

    deleted: list[str] = []
    monkeypatch.setattr(
        GuestPurgeService, "_ai_attachment_dir",
        staticmethod(lambda _uid: db_session.info.get("nonexistent") or __import__("pathlib").Path("/nonexistent")),
    )
    from app.services.note import note_asset_service as asset_mod

    real_delete = asset_mod.NoteAssetService.delete_asset

    def _tracking_delete(file_hash: str, ext: str) -> bool:
        deleted.append(f"{file_hash}.{ext}")
        return True

    monkeypatch.setattr(asset_mod.NoteAssetService, "delete_asset", staticmethod(_tracking_delete))

    db_session.add_all([
        _add_note(guest, db_session, title="访客笔记", content={"text": url}),
        _add_note(real, db_session, title="正式笔记", content={"text": url}),
    ])
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    assert not deleted, "仍被正式用户引用的资产不得删除"
    assert real_delete is not None


@pytest.mark.asyncio
async def test_unreferenced_asset_is_deleted(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch):
    """无人引用的资产应当被清理。"""
    from pathlib import Path

    from app.services.note import note_asset_service as asset_mod

    guest = await _make_guest(db_session)
    real = await _make_regular(db_session)
    orphan = "d" * 64
    shared = "e" * 64
    deleted: list[str] = []
    monkeypatch.setattr(
        GuestPurgeService, "_ai_attachment_dir",
        staticmethod(lambda _uid: Path("/nonexistent")),
    )
    monkeypatch.setattr(
        asset_mod.NoteAssetService, "delete_asset",
        staticmethod(lambda h, e: bool(deleted.append(f"{h}.{e}"))),
    )

    db_session.add_all([
        _add_note(guest, db_session, title="访客笔记", content={
            "a": f"/api/v1/notes/assets/{orphan}.png",
            "b": f"/api/v1/notes/assets/{shared}.png",
        }),
        _add_note(real, db_session, title="正式笔记", content={
            "b": f"/api/v1/notes/assets/{shared}.png",
        }),
    ])
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    deleted_hashes = {d.split(".")[0] for d in deleted}
    assert orphan in deleted_hashes, "无引用资产应被清理"
    assert shared not in deleted_hashes, "仍被引用的资产必须保留"


# ── 事件在账号清除后仍然保留 ───────────────────────────────────────


@pytest.mark.asyncio
async def test_events_survive_account_purge(db_session: AsyncSession):
    """事件表无外键：账号被物理删除后事件仍在，可继续审计。"""
    from app.models.guest_event import GuestEventType
    from app.services.guest_event_service import GuestEventService

    guest = await _make_guest(db_session)
    await GuestEventService.record(
        db_session, guest_id=guest.id, event_type=GuestEventType.LOGIN,
        ip_address="198.51.100.9", detail=None,
    )
    db_session.add(_add_note(guest, db_session, title="访客笔记"))
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    events = (await db_session.execute(
        select(GuestEvent).where(GuestEvent.guest_id == guest.id)
    )).scalars().all()
    assert events, "账号清除后事件必须保留"
    assert any(e.event_type == GuestEventType.LOGIN.value for e in events)


@pytest.mark.asyncio
async def test_purge_writes_session_end_with_note_count(db_session: AsyncSession):
    from app.models.guest_event import GuestEventType
    from app.services.guest_event_service import GuestEventService

    guest = await _make_guest(db_session)
    db_session.add_all([_add_note(guest, db_session, title="n1"), _add_note(guest, db_session, title="n2")])
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="idle", db=db_session)

    events = (await db_session.execute(
        select(GuestEvent).where(GuestEvent.guest_id == guest.id)
    )).scalars().all()
    ends = [e for e in events if e.event_type == GuestEventType.SESSION_END.value]
    assert len(ends) == 1
    assert ends[0].note_count_at_end == 2
    assert ends[0].detail == "idle"


# ── 清除后的令牌立即失效 ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_purged_guest_token_rejected(db_session: AsyncSession):
    """账号行删除后，其 JWT 必须立即 401。"""
    from httpx import ASGITransport, AsyncClient

    from app.config import get_settings
    from app.database import get_db
    from app.main import app
    from app.services.auth_service import AuthService

    guest = await _make_guest(db_session)
    token, _ = AuthService.create_access_token(guest.id)
    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test/api/v1",
    ) as ac:
        res = await ac.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    app.dependency_overrides.clear()

    assert res.status_code == 401
    assert get_settings().GUEST_LOGIN_ENABLED is True


# ── KB / 知识入库 / RAG / 技能残留 ─────────────────────────────────


def _blob_path(sha: str) -> Path:
    root = Path(__file__).resolve().parents[1] / "uploads" / "documents"
    return root / sha[:2] / f"{sha}.pdf"


@pytest.mark.asyncio
async def test_purge_deletes_kb_blob_only_after_last_reference(db_session: AsyncSession):
    """共用内容寻址文件：仍有他人引用时必须保留，最后一个引用消失才删。"""
    guest_a = await _make_guest(db_session, name="A")
    guest_b = await _make_guest(db_session, name="B")
    sha = uuid.uuid4().hex + uuid.uuid4().hex
    path = _blob_path(sha)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"%PDF-1.4 purge-test")

    try:
        for user in (guest_a, guest_b):
            root = KbRoot(user_id=user.id, name="知识库")
            db_session.add(root)
            await db_session.flush()
            db_session.add(KbFile(
                root_id=root.id,
                user_id=user.id,
                path=f"raw/{user.name}.pdf",
                content_hash=sha,
                size=18,
                storage_path=f"documents/{sha[:2]}/{sha}.pdf",
            ))
        await db_session.commit()

        await GuestPurgeService.purge_guest(guest_a.id, reason="manual", db=db_session)
        assert path.exists(), "另一个匿名账号仍引用同一文件，不能删"

        profile_b = await GuestPurgeService._collect(db_session, guest_b.id)
        assert profile_b and profile_b["document_blobs"], "必须收集到待清理的 KB 原件"

        await GuestPurgeService.purge_guest(guest_b.id, reason="manual", db=db_session)
        assert (await db_session.execute(
            select(func.count()).select_from(KbFile).where(KbFile.user_id == guest_b.id)
        )).scalar() == 0, "KB 行必须已删除"
        assert not path.exists(), "最后一个引用清除后必须删除磁盘原件"
    finally:
        path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_purge_deletes_ingest_temp_file_and_source_rows(db_session: AsyncSession):
    guest = await _make_guest(db_session)
    note = _add_note(guest, db_session, title="来源笔记")
    await db_session.flush()

    temp_dir = Path(__file__).resolve().parents[1] / "uploads" / "ingest"
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = temp_dir / f"{uuid.uuid4().hex}.pdf"
    temp_path.write_bytes(b"%PDF-1.4 temp")

    document = IngestDocument(
        user_id=guest.id,
        source_type="upload",
        external_id=f"purge-{uuid.uuid4().hex}",
        content_hash=uuid.uuid4().hex + uuid.uuid4().hex,
        title="临时来源",
        raw_meta={"file_path": str(temp_path), "filename": "temp.pdf"},
    )
    db_session.add(document)
    await db_session.flush()
    card = KnowledgeCard(
        user_id=guest.id,
        document_id=document.id,
        title="知识卡",
        summary="摘要",
    )
    db_session.add(card)
    await db_session.flush()
    db_session.add(IngestJob(document_id=document.id, stage="parse"))
    db_session.add(NoteSource(
        note_id=note.id, document_id=document.id, card_id=card.id,
    ))
    await db_session.commit()

    try:
        await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)
        assert not temp_path.exists(), "ingest 临时文件必须被清理"
        assert (await db_session.execute(
            select(func.count()).select_from(IngestDocument).where(
                IngestDocument.id == document.id,
            )
        )).scalar() == 0
        assert (await db_session.execute(
            select(func.count()).select_from(KnowledgeCard).where(
                KnowledgeCard.id == card.id,
            )
        )).scalar() == 0
        assert (await db_session.execute(
            select(func.count()).select_from(IngestJob).where(
                IngestJob.document_id == document.id,
            )
        )).scalar() == 0
        source_count = (await db_session.execute(
            select(func.count()).select_from(NoteSource).where(
                NoteSource.note_id == note.id,
            )
        )).scalar()
        assert source_count == 0
    finally:
        temp_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_purge_deletes_guest_skills_but_keeps_system_skills(db_session: AsyncSession):
    guest = await _make_guest(db_session)
    mine = AISkill(
        user_id=guest.id, code=f"mine_{uuid.uuid4().hex[:8]}",
        name="我的技能", prompt_template="p",
    )
    system = AISkill(
        user_id=None, code=f"sys_{uuid.uuid4().hex[:8]}",
        name="系统技能", prompt_template="p", is_builtin=True,
    )
    db_session.add_all([mine, system])
    await db_session.flush()
    db_session.add(PageSkillBinding(
        user_id=guest.id, page_name="notes", skill_id=mine.id, weight=50,
    ))
    await db_session.commit()

    await GuestPurgeService.purge_guest(guest.id, reason="manual", db=db_session)

    assert (await db_session.execute(
        select(func.count()).select_from(AISkill).where(AISkill.id == mine.id)
    )).scalar() == 0
    assert (await db_session.execute(
        select(func.count()).select_from(AISkill).where(AISkill.id == system.id)
    )).scalar() == 1, "系统内置技能不能随匿名账号删除"
    assert (await db_session.execute(
        select(func.count()).select_from(PageSkillBinding).where(
            PageSkillBinding.skill_id == mine.id,
        )
    )).scalar() == 0
