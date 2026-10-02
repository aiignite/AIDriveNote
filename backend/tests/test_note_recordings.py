"""笔记录音 / 转写服务层测试。

覆盖：录音创建与归属校验、转写分段排序、删除归属与软删、重转写重置、
音频直链签名，以及带 mock LLM 的转写润色写回。
"""
from __future__ import annotations

import importlib.util
import io
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# 注册 PostgreSQL 专用类型到 SQLite 的编译器（JSONB / TSVECTOR）
_sqlite_types_path = Path(__file__).parent / "sqlite_types.py"
_spec = importlib.util.spec_from_file_location("_aidrive_sqlite_types", _sqlite_types_path)
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_mod)

from app.models.note.asr import NoteAsrSettings, NoteCommonTerm  # noqa: E402
from app.models.note.note import Note, NoteFolder  # noqa: E402
from app.models.note.recording import NoteRecording, NoteTranscript  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.note.recording import (  # noqa: E402
    NoteRecordingService,
    build_audio_signature,
    build_audio_url,
    verify_audio_signature,
)

REC_TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
rec_test_engine = create_async_engine(REC_TEST_DB_URL, echo=False)
RecTestSession = async_sessionmaker(rec_test_engine, class_=AsyncSession, expire_on_commit=False)

# 建表顺序需满足外键依赖
_TABLES = [User, NoteFolder, Note, NoteRecording, NoteTranscript, NoteAsrSettings, NoteCommonTerm]


@pytest_asyncio.fixture
async def rec_db() -> AsyncSession:
    """仅创建录音相关表的最小数据库会话。"""
    async with rec_test_engine.begin() as conn:
        for table in _TABLES:
            await conn.run_sync(lambda sync, t=table: t.__table__.create(sync, checkfirst=True))
    async with RecTestSession() as session:
        yield session
    async with rec_test_engine.begin() as conn:
        for table in reversed(_TABLES):
            await conn.run_sync(lambda sync, t=table: t.__table__.drop(sync, checkfirst=True))


async def _create_user(db: AsyncSession, email: str = "rec@test.com") -> User:
    """创建并返回一个测试用户。"""
    user = User(email=email, password_hash="x", name=email)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def _create_note(db: AsyncSession, owner: User, title: str = "测试笔记") -> Note:
    """创建并返回一条归属于 ``owner`` 的笔记。"""
    note = Note(note_no=f"NT{uuid.uuid4().hex[:10]}", title=title, note_type="html", created_by=owner.id)
    db.add(note)
    await db.commit()
    await db.refresh(note)
    return note


@pytest.fixture
def patch_storage(monkeypatch):
    """屏蔽真实落盘与 ffprobe，避免测试触碰文件系统。"""
    monkeypatch.setattr(
        "app.services.note.recording.recording_service.save_recording_file",
        lambda file_obj, storage_path, max_bytes=0, chunk_size=0: 3,
    )
    monkeypatch.setattr(
        "app.services.note.recording.recording_service.NoteTranscriptionService.probe_duration_seconds",
        staticmethod(lambda storage_path: 42),
    )
    monkeypatch.setattr(
        "app.services.note.recording.recording_service.delete_recording_file",
        lambda storage_path: True,
    )


@pytest.mark.asyncio
async def test_create_recording_persists_and_probes(rec_db, patch_storage):
    """创建录音：状态为 Uploaded、时长来自探测、归属正确。"""
    user = await _create_user(rec_db)
    note = await _create_note(rec_db, user)
    service = NoteRecordingService()

    recording = await service.create_recording(
        rec_db,
        note_id=note.id,
        user_id=user.id,
        file_obj=io.BytesIO(b"abc"),
        file_name="voice.webm",
        mime_type="audio/webm",
        max_bytes=1024,
    )

    assert recording.status == "Uploaded"
    assert recording.progress_pct == 0
    assert recording.duration_seconds == 42
    assert recording.note_id == note.id
    assert recording.user_id == user.id
    assert recording.storage_path.endswith(".webm")


@pytest.mark.asyncio
async def test_create_recording_rejects_non_owner(rec_db, patch_storage):
    """非笔记归属人创建录音应被拒绝。"""
    owner = await _create_user(rec_db, "owner@test.com")
    intruder = await _create_user(rec_db, "intruder@test.com")
    note = await _create_note(rec_db, owner)
    service = NoteRecordingService()

    with pytest.raises(PermissionError):
        await service.create_recording(
            rec_db,
            note_id=note.id,
            user_id=intruder.id,
            file_obj=io.BytesIO(b"abc"),
            file_name="voice.webm",
            mime_type="audio/webm",
            max_bytes=1024,
        )


@pytest.mark.asyncio
async def test_get_full_transcript_orders_by_segment_index(rec_db):
    """转写分段应按 segment_index 升序返回。"""
    user = await _create_user(rec_db)
    recording = NoteRecording(
        note_id=None,
        user_id=user.id,
        file_name="a.webm",
        file_size=10,
        storage_path="uploads/note_recordings/2026/10/a.webm",
        status="Transcribed",
    )
    rec_db.add(recording)
    await rec_db.commit()

    for idx in (2, 0, 1):
        rec_db.add(
            NoteTranscript(
                recording_id=recording.id,
                segment_index=idx,
                start_time=float(idx),
                end_time=float(idx) + 1,
                text=f"seg-{idx}",
            )
        )
    await rec_db.commit()

    service = NoteRecordingService()
    segments = await service.get_full_transcript(rec_db, recording.id)
    assert [s.segment_index for s in segments] == [0, 1, 2]
    assert [s.text for s in segments] == ["seg-0", "seg-1", "seg-2"]


@pytest.mark.asyncio
async def test_delete_recording_enforces_ownership(rec_db, patch_storage):
    """删除录音：他人无权删除，归属人删除后软删。"""
    owner = await _create_user(rec_db, "owner2@test.com")
    other = await _create_user(rec_db, "other@test.com")
    recording = NoteRecording(
        note_id=None,
        user_id=owner.id,
        file_name="a.webm",
        file_size=10,
        storage_path="uploads/note_recordings/2026/10/del.webm",
        status="Uploaded",
    )
    rec_db.add(recording)
    await rec_db.commit()

    service = NoteRecordingService()
    with pytest.raises(PermissionError):
        await service.delete_recording(rec_db, recording.id, user_id=other.id)

    assert await service.delete_recording(rec_db, recording.id, user_id=owner.id) is True
    refreshed = await service.get_recording_detail(rec_db, recording.id)
    assert refreshed is None  # 软删后详情查询不再返回


@pytest.mark.asyncio
async def test_retranscribe_resets_status_and_clears_segments(rec_db, patch_storage):
    """重转写：状态回到 Uploaded，旧分段被清空。"""
    user = await _create_user(rec_db, "retry@test.com")
    recording = NoteRecording(
        note_id=None,
        user_id=user.id,
        file_name="a.webm",
        file_size=10,
        storage_path="uploads/note_recordings/2026/10/retry.webm",
        status="Transcribed",
        progress_pct=100,
        error_message="boom",
    )
    rec_db.add(recording)
    await rec_db.commit()
    rec_db.add(
        NoteTranscript(
            recording_id=recording.id, segment_index=0, start_time=0, end_time=1, text="旧文本"
        )
    )
    await rec_db.commit()

    service = NoteRecordingService()
    updated = await service.retranscribe(rec_db, recording.id, user_id=user.id)

    assert updated is not None
    assert updated.status == "Uploaded"
    assert updated.progress_pct == 0
    assert updated.error_message is None
    assert await service.get_full_transcript(rec_db, recording.id) == []


def test_audio_signature_roundtrip():
    """音频签名可校验，且直链包含签名参数。"""
    rid = str(uuid.uuid4())
    sig = build_audio_signature(rid)

    assert verify_audio_signature(rid, sig) is True
    assert verify_audio_signature(rid, "bad-signature") is False
    assert verify_audio_signature(rid, None) is False
    assert build_audio_url(rid).endswith(f"/note-recordings/{rid}/audio?s={sig}")


@pytest.mark.asyncio
async def test_save_browser_transcripts_marks_transcribed(rec_db, patch_storage):
    """浏览器 ASR 分段落库：状态直接 Transcribed，时长/语言/来源被记录。"""
    user = await _create_user(rec_db, "browser@test.com")
    service = NoteRecordingService()
    recording = await service.create_recording(
        rec_db,
        note_id=None,
        user_id=user.id,
        file_obj=io.BytesIO(b"abc"),
        file_name="browser.webm",
        mime_type="audio/webm",
        max_bytes=1024,
    )

    segments = [
        {"text": "第一句。", "start_time": 0.0, "end_time": 1.5},
        {"text": "第二句。", "start_time": 1.5, "end_time": 3.0},
        {"text": "  ", "start_time": 3.0, "end_time": 4.0},  # 空白段应被跳过
    ]
    updated = await service.save_browser_transcripts(
        rec_db,
        recording.id,
        segments,
        duration_seconds=4.0,
        language="zh-CN",
    )

    assert updated is not None
    assert updated.status == "Transcribed"
    assert updated.progress_pct == 100
    assert updated.model_size == "browser"
    assert updated.language == "zh-CN"
    assert updated.duration_seconds == 4.0

    rows = await service.get_full_transcript(rec_db, recording.id)
    assert [s.text for s in rows] == ["第一句。", "第二句。"]
    assert rows[0].start_time == 0.0
    assert rows[1].end_time == 3.0


@pytest.mark.asyncio
async def test_apply_refinement_writes_back_text(rec_db, monkeypatch):
    """润色：mock LLM 返回后，新文本写回且旧分段被软删。"""
    from app.services.note.recording import transcript_refinement_service as trs

    user = await _create_user(rec_db, "refine@test.com")
    note = await _create_note(rec_db, user, "润色笔记")
    recording = NoteRecording(
        note_id=note.id,
        user_id=user.id,
        file_name="a.webm",
        file_size=10,
        storage_path="uploads/note_recordings/2026/10/refine.webm",
        status="Transcribed",
    )
    rec_db.add(recording)
    await rec_db.commit()
    rec_db.add(
        NoteTranscript(
            recording_id=recording.id,
            segment_index=0,
            start_time=0,
            end_time=1.5,
            text="原始错别字文本",
            language="zh",
        )
    )
    await rec_db.commit()

    async def _fake_refine(self, segments, *, context=None, db=None):  # noqa: ANN001
        return [trs.RefinedSegment(start=0.0, end=1.5, text="润色后的正确文本。")]

    monkeypatch.setattr(trs.TranscriptRefinementService, "refine", _fake_refine)

    count = await trs.apply_refinement_to_recording(rec_db, recording.id)
    assert count == 1

    rows = (
        await rec_db.execute(
            NoteTranscript.__table__.select().where(
                NoteTranscript.recording_id == recording.id
            )
        )
    ).all()
    active = [r for r in rows if not r.is_deleted]
    assert len(active) == 1
    assert active[0].text == "润色后的正确文本。"