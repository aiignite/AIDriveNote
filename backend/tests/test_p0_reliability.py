"""P0 优化项的回归测试。

覆盖《AIDriveNote 产品能力演进方案》P0 章节：

- P0-1 修订历史容量治理（保留最近 N 条 + 置位不淘汰）
- P0-2 中文全文检索策略（zhparser / pg_trgm / ILIKE 三级降级）
- P0-3 API Key 加密（往返、幂等、存量明文兼容、掩码占位符）
- P0-5 笔记编号生成（年份前缀、6 位补零、与既有编号不冲突）
- P0-7 图片资产（data URL 解析、内容寻址去重、越界防护、正文替换）
"""
from __future__ import annotations

import base64
import uuid

import pytest

from app.services.note.note_asset_service import NoteAssetService
from app.services.note.search_config import (
    SearchConfigService,
    SearchStrategy,
    contains_cjk,
    latin_tokens,
)
from app.services.secret_crypto import (
    MASKED_SECRET_PLACEHOLDER,
    decrypt_secret,
    encrypt_secret,
    is_encrypted_secret,
    is_masked_secret_placeholder,
    mask_secret,
)


# ── P0-1 修订历史容量治理 ──

@pytest.mark.asyncio
async def test_prune_revisions_keeps_latest_n(note_db) -> None:
    """超过保留上限后，最旧的未置位修订应被淘汰。"""
    from app.models.note.note import Note, NoteRevision
    from app.services.note.note_enhance_service import NoteRevisionService

    note_id = uuid.uuid4()
    note_db.add(Note(
        id=note_id, note_no="NT2026000001", title="prune", note_type="markdown",
    ))
    await note_db.commit()

    for i in range(8):
        note_db.add(NoteRevision(
            note_id=note_id, seq=i + 1, title=f"v{i}",
            content_snapshot={"text": str(i)}, is_pinned=False,
        ))
    await note_db.commit()

    removed = await NoteRevisionService.prune_revisions(note_db, note_id, keep=3)
    await note_db.commit()
    assert removed == 5

    remaining = await NoteRevisionService.list_revisions(note_db, note_id, limit=50)
    assert len(remaining) == 3
    # 保留的是最新的三条
    assert {r.content_snapshot["text"] for r in remaining} == {"5", "6", "7"}


@pytest.mark.asyncio
async def test_prune_revisions_keeps_pinned(note_db) -> None:
    """置位修订（如「恢复前快照」）不参与淘汰。"""
    from app.models.note.note import Note, NoteRevision
    from app.services.note.note_enhance_service import NoteRevisionService

    note_id = uuid.uuid4()
    note_db.add(Note(
        id=note_id, note_no="NT2026000002", title="prune-pinned", note_type="markdown",
    ))
    note_db.add(NoteRevision(
        note_id=note_id, seq=0, title="anchor",
        content_snapshot={"text": "恢复前快照"}, is_pinned=True,
    ))
    await note_db.commit()

    for i in range(6):
        note_db.add(NoteRevision(
            note_id=note_id, seq=i + 1, title=f"v{i}",
            content_snapshot={"text": str(i)}, is_pinned=False,
        ))
    await note_db.commit()

    await NoteRevisionService.prune_revisions(note_db, note_id, keep=2)
    await note_db.commit()

    rows = (
        await note_db.query(NoteRevision)
        .filter(NoteRevision.note_id == note_id)
        .all()
    )
    pinned = [r for r in rows if r.is_pinned]
    assert len(pinned) == 1
    assert pinned[0].content_snapshot["text"] == "恢复前快照"
    assert len([r for r in rows if not r.is_pinned]) == 2


@pytest.mark.asyncio
async def test_create_revision_assigns_incrementing_seq(note_db) -> None:
    """create_revision 应分配严格递增的 seq（created_at 同秒时也能区分先后）。"""
    from app.models.note.note import Note
    from app.services.note.note_enhance_service import NoteRevisionService

    note = Note(note_no="NT2026000099", title="seq", note_type="markdown")
    note_db.add(note)
    await note_db.commit()

    seqs = []
    for i in range(4):
        rev = await NoteRevisionService.create_revision(
            note_db, note, None, f"v{i}",
        )
        seqs.append(rev.seq)
    await note_db.commit()

    assert seqs == sorted(seqs)
    assert len(set(seqs)) == 4


@pytest.mark.asyncio
async def test_update_note_prunes_revisions(note_db) -> None:
    """连续更新同一笔记时，修订表不会无限增长。"""
    from app.config import get_settings
    from app.services.note.note_service import NoteService

    user = await _make_user(note_db, "prune-update@test.com")
    keep = get_settings().NOTE_REVISION_KEEP
    note = await NoteService.create_note(note_db, {
        "title": "churn", "note_type": "markdown",
        "content": {"text": "v0"}, "created_by": user.id, "updated_by": user.id,
    })

    # 写入 keep + 3 次更新，验证表内始终不超过 keep 条未置位修订
    for i in range(1, keep + 4):
        await NoteService.update_note(note_db, note.id, {
            "content": {"text": f"v{i}"}, "updated_by": user.id,
        })

    from app.models.note.note import NoteRevision

    rows = (
        await note_db.query(NoteRevision)
        .filter(NoteRevision.note_id == note.id)
        .all()
    )
    assert len(rows) <= keep


# ── P0-2 中文检索策略 ──

def test_contains_cjk() -> None:
    assert contains_cjk("笔记") is True
    assert contains_cjk("hello 世界") is True
    assert contains_cjk("hello") is False
    assert contains_cjk("") is False
    assert contains_cjk(None) is False


def test_latin_tokens() -> None:
    assert latin_tokens("FastAPI 异步") == ["FastAPI"]
    assert latin_tokens("gpt-4o mini") == ["gpt", "4o", "mini"]
    assert latin_tokens("纯中文") == []


def test_tsquery_config_maps_strategy() -> None:
    assert SearchConfigService.tsquery_config(SearchStrategy.ZHPARSER) == "zhparser"
    assert SearchConfigService.tsquery_config(SearchStrategy.TRIGRAM) == "simple"
    assert SearchConfigService.tsquery_config(SearchStrategy.ILIKE) == "simple"


@pytest.mark.asyncio
async def test_resolve_falls_back_to_ilike_on_probe_failure(note_db) -> None:
    """探测不可用时退到 ILIKE，且缓存可重置。"""
    SearchConfigService.reset_cache()
    strategy = await SearchConfigService.resolve(note_db, refresh=True)
    # SQLite 测试环境下 pg_extension 不存在 → 必然落到 ILIKE
    assert strategy == SearchStrategy.ILIKE
    SearchConfigService.reset_cache()


@pytest.mark.asyncio
async def test_full_text_search_empty_query(note_db) -> None:
    """空查询直接返回空结果，不打数据库。"""
    from app.services.note.note_enhance_service import NoteSearchService

    items, total = await NoteSearchService.full_text_search(
        note_db, user_id=uuid.uuid4(), query="   ",
    )
    assert items == []
    assert total == 0


# ── P0-3 API Key 加密 ──

def test_encrypt_decrypt_roundtrip() -> None:
    cipher = encrypt_secret("sk-proj-abcdef123456")
    assert cipher is not None
    assert is_encrypted_secret(cipher)
    assert cipher != "sk-proj-abcdef123456"
    assert decrypt_secret(cipher) == "sk-proj-abcdef123456"


def test_encrypt_is_idempotent() -> None:
    """重复加密不应二次包装，否则将无法解密。"""
    once = encrypt_secret("sk-123")
    twice = encrypt_secret(once)
    assert once == twice
    assert decrypt_secret(twice) == "sk-123"


def test_plaintext_passthrough_for_legacy_rows() -> None:
    """存量明文应原样返回，保证迁移前功能不中断。"""
    assert decrypt_secret("sk-legacy-plain") == "sk-legacy-plain"
    assert is_encrypted_secret("sk-legacy-plain") is False


def test_empty_and_none() -> None:
    assert encrypt_secret(None) is None
    assert encrypt_secret("   ") is None
    assert decrypt_secret(None) is None
    assert mask_secret(None) is None


def test_mask_placeholder_helpers() -> None:
    assert is_masked_secret_placeholder(MASKED_SECRET_PLACEHOLDER) is True
    assert is_masked_secret_placeholder("sk-real") is False
    assert mask_secret(encrypt_secret("sk-abc")) == MASKED_SECRET_PLACEHOLDER


def test_corrupt_ciphertext_returns_none() -> None:
    """密钥轮换 / 数据损坏时不应抛异常拖垮列表接口。"""
    assert decrypt_secret("enc::not-a-real-token") is None


# ── P0-5 笔记编号 ──

@pytest.mark.asyncio
async def test_next_note_no_format_and_monotonic(note_db) -> None:
    """编号形如 NT<year><6位序号>，且随创建递增。"""
    from datetime import datetime

    from app.services.note.note_service import NoteService

    year = datetime.now().year
    first = await NoteService._next_note_no(note_db, year)
    assert first == f"NT{year}000001"

    user = await _make_user(note_db, "noteno@test.com")
    note = await NoteService.create_note(note_db, {
        "title": "first", "note_type": "markdown",
        "content": {"text": "x"}, "created_by": user.id, "updated_by": user.id,
    })
    assert note.note_no == f"NT{year}000001"

    second = await NoteService._next_note_no(note_db, year)
    assert second == f"NT{year}000002"
    assert second != note.note_no


# ── P0-7 图片资产 ──

def _png_data_url(payload: bytes = b"\x89PNG\r\n\x1a\nfake") -> str:
    return "data:image/png;base64," + base64.b64encode(payload).decode()


def test_parse_data_url_valid() -> None:
    parsed = NoteAssetService.parse_data_url(_png_data_url())
    assert parsed is not None
    mime, payload = parsed
    assert mime == "image/png"
    assert payload.startswith(b"\x89PNG")


def test_parse_data_url_rejects_unsupported() -> None:
    assert NoteAssetService.parse_data_url("data:application/pdf;base64,AAAA") is None
    assert NoteAssetService.parse_data_url("data:image/png;base64,!!!notbase64!!!") is None
    assert NoteAssetService.parse_data_url("https://example.com/a.png") is None
    assert NoteAssetService.parse_data_url("") is None


def test_store_image_content_addressed_dedup(tmp_path, monkeypatch) -> None:
    """相同内容只落一份磁盘文件，返回同一 URL。"""
    monkeypatch.setattr(
        "app.services.note.note_asset_service._uploads_root", lambda: tmp_path,
    )
    import asyncio

    payload = b"\x89PNG\r\n\x1a\nunique-content"
    a = asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        NoteAssetService.store_image(None, uuid.uuid4(), payload, "image/png"),
    )
    b = asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        NoteAssetService.store_image(None, uuid.uuid4(), payload, "image/png"),
    )
    assert a["url"] == b["url"]
    assert a["hash"] == b["hash"]
    assert a["size"] == len(payload)


def test_store_image_rejects_oversize(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.note.note_asset_service._uploads_root", lambda: tmp_path,
    )
    from app.exceptions import BadRequestException
    import asyncio

    loop = asyncio.get_event_loop_policy().new_event_loop()
    with pytest.raises(BadRequestException):
        loop.run_until_complete(
            NoteAssetService.store_image(
                None, uuid.uuid4(), b"x" * (6 * 1024 * 1024), "image/png",
            ),
        )


def test_store_image_rejects_bad_mime(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.note.note_asset_service._uploads_root", lambda: tmp_path,
    )
    from app.exceptions import BadRequestException
    import asyncio

    loop = asyncio.get_event_loop_policy().new_event_loop()
    with pytest.raises(BadRequestException):
        loop.run_until_complete(
            NoteAssetService.store_image(None, uuid.uuid4(), b"data", "application/zip"),
        )


def test_resolve_file_path_blocks_traversal() -> None:
    """非法文件名 / 越界路径一律视为不存在。"""
    assert NoteAssetService.resolve_file_path("/notes/assets/../../etc/passwd") is None
    assert NoteAssetService.resolve_file_path("/notes/assets/shortname.png") is None
    assert NoteAssetService.resolve_file_path("/other/abc.png") is None


def test_find_and_replace_data_urls() -> None:
    data_url = _png_data_url()
    content = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "hi"}]},
            {"type": "image", "props": {"url": data_url, "caption": data_url}},
        ],
    }
    found = NoteAssetService.find_data_urls(content)
    assert len(found) == 2

    replaced = NoteAssetService.replace_data_url(
        content, data_url, "/api/v1/notes/assets/deadbeef.png",
    )
    assert NoteAssetService.find_data_urls(replaced) == []
    assert replaced["content"][1]["props"]["url"] == "/api/v1/notes/assets/deadbeef.png"
    # 原对象不被就地修改，便于失败回滚
    assert NoteAssetService.find_data_urls(content) == found


def test_find_data_urls_empty_content() -> None:
    assert NoteAssetService.find_data_urls(None) == []
    assert NoteAssetService.find_data_urls({}) == []
    assert NoteAssetService.replace_data_url(None, "x", "y") is None


# ── fixtures ──

# note_db 由 tests/conftest.py 提供：仅创建 user / folder / note / link / revision，
# 规避完整 schema 在 SQLite 下的 PG 专有类型问题。


async def _make_user(db, email: str):
    """创建一个测试用户（口令无需真实校验）。"""
    from app.models.user import User

    user = User(email=email, password_hash="x", name="P0 Tester")
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user