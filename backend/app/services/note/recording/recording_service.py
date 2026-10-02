"""笔记录音服务——围绕音频上传、转写状态机与转写持久化的 DB 感知编排。

状态机：
    Uploaded     — 文件已存储，等待转写
    Transcribing — Whisper 流水线运行中
    Transcribed  — 分段已写入，可供消费
    Failed       — 流水线出错；``error_message`` 已填充

所有公开方法均为 async 且接收 ``AsyncSession``，让路由层保持轻薄。
服务自持一个 ``asyncio.Semaphore``，确保同一时刻至多运行一条转写流水线。

.. note::
   转写进度持久化：``progress_callback`` 通过
   ``asyncio.run_coroutine_threadsafe`` 把进度写库任务调度回主事件循环，
   Whisper 推理线程不阻塞，进度可真实刷新。
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, BinaryIO

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note
from app.models.note.recording import (
    NoteRecording,
    NoteTranscript,
)
from app.services.note.recording.audio_storage import (
    build_storage_path,
    delete_recording_file,
    save_recording_file,
)
from app.services.note.recording.transcription_service import (
    NoteTranscriptionError,
    NoteTranscriptionService,
)

logger = logging.getLogger(__name__)

# 模块级串行信号量 — 同进程内至多 1 个并发转写任务
_GLOBAL_TRANSCRIPTION_SEMAPHORE = asyncio.Semaphore(1)


class NoteRecordingService:
    """笔记录音生命周期的有状态门面。

    实例创建开销很小；重型状态（Whisper 模型、信号量）位于模块/类级别，
    因此在同一 worker 进程内可跨请求存活。
    """

    def __init__(self) -> None:
        # 全局并发上限由配置控制；保留服务级锁作为兼容占位
        self._semaphore = _GLOBAL_TRANSCRIPTION_SEMAPHORE
        # 最新进度缓存（key=recording_id），供转写线程在段间安全地写库
        self._latest_progress: dict[uuid.UUID, int] = {}
        # 主事件循环引用：在第一次 transcribe 任务调度时捕获，
        # 用于把 progress_callback 从 worker thread 桥接到主 async loop。
        self._main_loop: asyncio.AbstractEventLoop | None = None
        # NoteTranscriptionService 在运行时才需要；按任务创建以读取当前 DB 设置。
        self._transcriber: NoteTranscriptionService | None = None
        # 当前任务使用的语言，供后续写 transcript 复用。
        self._current_language: str | None = None

    # ── 归属校验 ────────────────────────────────────────────────────────

    async def _assert_note_owner(
        self,
        db: AsyncSession,
        note_id: uuid.UUID,
        user_id: uuid.UUID,
    ) -> Note | None:
        """校验笔记归属：笔记必须存在且属于 ``user_id``。

        归属优先取 ``Note.user_id``（若模型提供），否则回退到 ``Note.created_by``。
        不属于该用户时抛出 ``PermissionError``。
        """
        note = (
            await db.execute(
                select(Note).where(
                    Note.id == note_id,
                    Note.is_deleted == False,  # noqa: E712
                )
            )
        ).scalar_one_or_none()
        if note is None:
            raise PermissionError(f"note {note_id} not found")
        # 兼容不同字段命名：优先 user_id，其次 created_by
        owner = getattr(note, "user_id", None) or getattr(note, "created_by", None)
        if owner is not None and owner != user_id:
            raise PermissionError(f"user {user_id} does not own note {note_id}")
        return note

    # ── 1. 创建录音 ─────────────────────────────────────────────────────

    async def create_recording(
        self,
        db: AsyncSession,
        *,
        note_id: uuid.UUID | None,
        user_id: uuid.UUID,
        file_obj: BinaryIO,
        file_name: str,
        mime_type: str | None,
        max_bytes: int,
    ) -> NoteRecording:
        """以 ``Uploaded`` 状态持久化一条新录音，并把文件流式写入磁盘。

        若指定 ``note_id``，会先校验该笔记归属当前用户。调用方负责再触发
        后台转写任务。
        """
        # 归属校验（仅当录音关联到某条笔记时）
        if note_id is not None:
            await self._assert_note_owner(db, note_id, user_id)

        recording_id = uuid.uuid4()
        storage_path = build_storage_path(str(recording_id), file_name)

        # 1) 流式写盘（超过上限会抛 ValueError）
        save_recording_file(file_obj, storage_path, max_bytes=max_bytes)

        # 2) 预检时长
        try:
            duration = NoteTranscriptionService.probe_duration_seconds(storage_path)
        except Exception:  # noqa: BLE001
            duration = -1
        size = 0
        try:
            from app.services.note.recording.audio_storage import absolute_path
            size = absolute_path(storage_path).stat().st_size
        except OSError:
            size = 0

        # 录音元数据使用环境默认值；run_transcription 时会按当前 DB 设置重新解析。
        from app.services.note.recording.asr_settings_service import NoteAsrSettingsService

        default_settings = NoteAsrSettingsService._env_defaults()
        recording = NoteRecording(
            id=recording_id,
            note_id=note_id,
            user_id=user_id,
            file_name=file_name,
            file_size=size,
            duration_seconds=duration if duration and duration > 0 else None,
            mime_type=mime_type,
            storage_path=storage_path,
            status="Uploaded",
            progress_pct=0,
            model_size=default_settings.get("model"),
            language=default_settings.get("language") or None,
            is_deleted=False,
        )
        db.add(recording)
        await db.commit()

        # 重新查询以遵循 “不使用 db.refresh” 约定
        return await self.get_recording_detail(db, recording.id)  # type: ignore[reportReturnType]  类型修复

    # ── 2. 后台转写 ─────────────────────────────────────────────────────

    async def run_transcription(
        self,
        recording_id: uuid.UUID,
    ) -> None:
        """重型工作：取文件、跑 Whisper、写转写。

        设计为从 ``BackgroundTasks`` 调用。

        会话生命周期（长 ffmpeg+Whisper 任务期间避免 asyncpg 连接被
        server/pool 关闭 → 状态卡在 Transcribing 永不更新）：

            1) 短会话 #1：状态检查 + 切到 Transcribing + 取 storage_path，**然后关闭**
            2) 跑 ffmpeg + Whisper（不持任何 DB 会话，允许任意时长）
            3) 短会话 #2：写 transcripts + LLM 润色 + 切到 Transcribed
        """
        # 延迟导入以避免模块导入期的硬依赖
        from app.database import AsyncSessionLocal as SessionLocal

        # ── 0) 捕获主事件循环：供 progress_callback 跨线程写库 ──
        self._main_loop = asyncio.get_running_loop()

        # ── 1) 短会话：状态切到 Transcribing + 拿 storage_path ────────
        storage_path: str | None = None
        async with SessionLocal() as db:
            current_status = (
                await db.execute(
                    select(NoteRecording.status).where(NoteRecording.id == recording_id)
                )
            ).scalar_one_or_none()
            if current_status is None:
                logger.warning("run_transcription: recording %s missing", recording_id)
                return
            if current_status not in {"Uploaded", "Failed"}:
                logger.info(
                    "run_transcription: skip recording %s in status %s",
                    recording_id,
                    current_status,
                )
                return

            await db.execute(
                update(NoteRecording)
                .where(NoteRecording.id == recording_id)
                .values(
                    status="Transcribing",
                    progress_pct=1,
                    error_message=None,
                )
            )
            await db.commit()

            storage_path = (
                await db.execute(
                    select(NoteRecording.storage_path).where(NoteRecording.id == recording_id)
                )
            ).scalar_one_or_none()
        # ←── 会话 #1 关闭，连接归还 pool，不再被长任务持有

        if not storage_path:
            async with SessionLocal() as db:
                await self._mark_failed(db, recording_id, "storage_path missing")
            return

        # ── 2) 创建转写服务（读取当前 DB ASR 设置）后关闭会话，再跑长任务
        async with SessionLocal() as settings_db:
            self._transcriber = await NoteTranscriptionService.create(settings_db)
            self._current_language = self._transcriber._language

        # ── 3) 长任务：ffmpeg + Whisper（无 DB 会话，连接安全归还 pool）──
        try:
            async with self._semaphore:
                if self._transcriber is None:
                    raise NoteTranscriptionError("transcription service not initialized")
                segments = await self._transcriber.transcribe(
                    storage_path,
                    progress_callback=lambda pct: self._update_progress_sync(
                        recording_id, pct
                    ),
                )
        except NoteTranscriptionError as exc:
            logger.warning("transcription pipeline error: %s", exc)
            async with SessionLocal() as db:
                await self._mark_failed(db, recording_id, str(exc))
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("transcription crashed: %s", exc)
            async with SessionLocal() as db:
                await self._mark_failed(db, recording_id, f"unexpected: {exc}")
            return

        from app.services.note.recording.transcript_refinement_service import merge_whisper_segments
        segments = merge_whisper_segments(segments)

        # ── 3) 短会话 #2：写 transcripts + LLM 润色 + 切到 Transcribed ─
        async with SessionLocal() as db:
            try:
                # 3a) 清空旧 transcript 并写入新段落
                await self._replace_transcripts(db, recording_id, segments)

                # 3b) LLM 错别字修复 + 顺句 + 加标点 + 去重 + 简繁转换
                # 使用 apply_refinement_to_recording：含去重 + 章节重建 +
                # 简繁转换三级管道（zhconv → 港台用词 → 字符级 fallback）。
                # 注意：apply_refinement_to_recording 内部会再调一次
                # apply_chapters_and_keywords，所以这里不再单独调。
                from app.services.note.recording.transcript_refinement_service import (
                    apply_refinement_to_recording,
                )
                n = await apply_refinement_to_recording(db, recording_id)
                logger.info(
                    "auto-refined %d segments for %s after transcription",
                    n, recording_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("post-transcript write failed: %s", exc)
                # 落库失败也要把状态切到 Transcribed（transcripts 已写入），
                # 不然 UI 永远卡在 Transcribing。
                final_progress = self._latest_progress.pop(recording_id, 100)
                try:
                    await db.rollback()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    await db.execute(
                        update(NoteRecording)
                        .where(NoteRecording.id == recording_id)
                        .values(
                            status="Transcribed",
                            progress_pct=max(80, min(100, int(final_progress))),
                            error_message=f"refinement failed: {exc}",
                        )
                    )
                    await db.commit()
                except Exception:  # noqa: BLE001
                    logger.exception("post-transcript final-status write failed")
                return

            final_progress = self._latest_progress.pop(recording_id, 100)
            await db.execute(
                update(NoteRecording)
                .where(NoteRecording.id == recording_id)
                .values(
                    status="Transcribed",
                    progress_pct=max(80, min(100, int(final_progress))),
                    error_message=None,
                )
            )
            await db.commit()

    def _update_progress_sync(self, recording_id: uuid.UUID, pct: int) -> None:
        """尽力把进度真正写入数据库。

        调用来源：
        - Whisper worker 线程（本地模式）→ 经 run_coroutine_threadsafe 桥接
        - 异步远程路径 / 主循环心跳 → create_task
        """
        pct = max(0, min(100, int(pct)))
        # 写本地缓存（最终回退用）
        self._latest_progress[recording_id] = pct
        # 拿到主事件循环引用
        try:
            loop = self._main_loop
        except AttributeError:
            loop = None
        if loop is None or loop.is_closed():
            # 没有可用 loop：仅缓存，等转写完一次性写
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        try:
            if running is loop:
                # 已在主循环上（远程 ASR / 心跳）
                loop.create_task(self._update_progress(recording_id, pct))
            else:
                # worker 线程 → 调度回主循环
                asyncio.run_coroutine_threadsafe(
                    self._update_progress(recording_id, pct), loop
                )
        except RuntimeError:
            # loop 关闭中，忽略
            pass

    async def _update_progress(self, recording_id: uuid.UUID, pct: int) -> None:
        """把单个进度值写入数据库。"""
        from app.database import AsyncSessionLocal as SessionLocal

        async with SessionLocal() as db:
            await db.execute(
                update(NoteRecording)
                .where(NoteRecording.id == recording_id)
                .values(progress_pct=max(0, min(100, int(pct))))
            )
            await db.commit()

    async def _mark_failed(
        self, db: AsyncSession, recording_id: uuid.UUID, message: str
    ) -> None:
        """把录音标记为 Failed 并记录错误信息。"""
        await db.execute(
            update(NoteRecording)
            .where(NoteRecording.id == recording_id)
            .values(
                status="Failed",
                error_message=message[:2000],
                progress_pct=0,
            )
        )
        await db.commit()

    async def _replace_transcripts(
        self,
        db: AsyncSession,
        recording_id: uuid.UUID,
        segments: list[Any],
    ) -> None:
        """清空旧分段并写入新分段（硬删后重建，文本先转简体）。"""
        from sqlalchemy import delete as sql_delete  # 局部别名避免遮蔽

        await db.execute(
            sql_delete(NoteTranscript)
            .where(NoteTranscript.recording_id == recording_id)
        )
        await db.flush()

        from app.services.note.recording.transcript_refinement_service import (
            _simplify_chinese,
        )

        for idx, seg in enumerate(segments):
            db.add(
                NoteTranscript(
                    id=uuid.uuid4(),
                    recording_id=recording_id,
                    segment_index=idx,
                    start_time=float(seg.start),
                    end_time=float(seg.end),
                    speaker_label=None,
                    text=_simplify_chinese(str(seg.text or "").strip()),
                    confidence=seg.confidence,
                    language=self._current_language,
                )
            )
        await db.commit()

    # ── 3. 查询 ─────────────────────────────────────────────────────────

    async def save_browser_transcripts(
        self,
        db: AsyncSession,
        recording_id: uuid.UUID,
        segments: list[dict[str, Any]],
        *,
        duration_seconds: float | None = None,
        language: str | None = None,
    ) -> NoteRecording | None:
        """浏览器内置 ASR（Web Speech API）结果直接落库。

        与 Whisper 流水线不同：不切分音频、不自动润色，浏览器原文原样写入，
        录音状态直接置为 ``Transcribed``（``model_size`` 标记为 ``browser``
        便于识别来源）。用户可随后在面板点「AI 整理」调用系统 LLM 整理。

        @param db 数据库会话
        @param recording_id 录音 id
        @param segments 浏览器识别分段：[{text, start_time, end_time}, ...]
        @param duration_seconds 客户端上报的音频时长（秒），可为空
        @param language 识别语言（如 zh-CN）
        @returns 更新后的录音记录；不存在时返回 None
        """
        from sqlalchemy import delete as sql_delete

        recording = await self.get_recording_detail(db, recording_id)
        if not recording:
            return None

        # 时长：优先使用客户端上报值（浏览器有真实录制时长，且容器内无 ffprobe）
        if duration_seconds is not None and duration_seconds > 0:
            recording.duration_seconds = float(duration_seconds)

        # 清空旧分段后按顺序重建
        await db.execute(
            sql_delete(NoteTranscript).where(NoteTranscript.recording_id == recording_id)
        )
        await db.flush()

        for idx, seg in enumerate(segments):
            text = str(seg.get("text") or "").strip()
            if not text:
                continue
            db.add(
                NoteTranscript(
                    id=uuid.uuid4(),
                    recording_id=recording_id,
                    segment_index=idx,
                    start_time=float(seg.get("start_time") or 0),
                    end_time=float(seg.get("end_time") or 0),
                    speaker_label=None,
                    text=text,
                    confidence=None,
                    language=language,
                )
            )

        recording.status = "Transcribed"
        recording.progress_pct = 100
        recording.error_message = None
        recording.model_size = "browser"  # 标记转写来源：浏览器内置 ASR
        if language:
            recording.language = language
        await db.commit()
        return await self.get_recording_detail(db, recording_id)

    async def get_recording_detail(
        self, db: AsyncSession, recording_id: uuid.UUID
    ) -> NoteRecording | None:
        """按 id 获取未删除的录音（不预加载 transcripts）。"""
        # 不 selectinload transcripts —— 避免触发其他无关 ORM mapper 初始化问题。
        stmt = (
            select(NoteRecording)
            .where(NoteRecording.is_deleted == False)  # noqa: E712  SQLAlchemy 查询表达式
            .where(NoteRecording.id == recording_id)
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    async def list_recordings(
        self,
        db: AsyncSession,
        *,
        note_id: uuid.UUID,
        user_id: uuid.UUID | None = None,
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
    ) -> list[NoteRecording]:
        """列出某条笔记下的录音；给定 user_id 时先校验归属。"""
        if user_id is not None:
            await self._assert_note_owner(db, note_id, user_id)
        stmt = (
            select(NoteRecording)
            .where(NoteRecording.is_deleted == False)  # noqa: E712  SQLAlchemy 查询表达式
            .where(NoteRecording.note_id == note_id)
            .order_by(NoteRecording.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        if status:
            stmt = stmt.where(NoteRecording.status == status)
        result = await db.execute(stmt)
        return list(result.scalars().unique().all())

    async def list_user_recordings(
        self,
        db: AsyncSession,
        *,
        user_id: uuid.UUID,
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
    ) -> list[NoteRecording]:
        """列出某用户上传的全部录音（不限定笔记）。

        供前端未传 ``note_id`` 时使用，按创建时间倒序。
        """
        stmt = (
            select(NoteRecording)
            .where(NoteRecording.is_deleted == False)  # noqa: E712  SQLAlchemy 查询表达式
            .where(NoteRecording.user_id == user_id)
            .order_by(NoteRecording.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        if status:
            stmt = stmt.where(NoteRecording.status == status)
        result = await db.execute(stmt)
        return list(result.scalars().unique().all())

    async def get_full_transcript(
        self,
        db: AsyncSession,
        recording_id: uuid.UUID,
    ) -> list[NoteTranscript]:
        """按分段序号返回录音的完整转写。"""
        stmt = (
            select(NoteTranscript)
            .where(NoteTranscript.is_deleted == False)  # noqa: E712  SQLAlchemy 查询表达式
            .where(NoteTranscript.recording_id == recording_id)
            .order_by(NoteTranscript.segment_index.asc())
        )
        result = await db.execute(stmt)
        return list(result.scalars().all())

    # ── 4. 删除 / 重转写 ────────────────────────────────────────────────

    async def delete_recording(
        self,
        db: AsyncSession,
        recording_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None = None,
    ) -> bool:
        """软删除录音并清理原始文件；给定 user_id 时校验归属。"""
        recording = await self.get_recording_detail(db, recording_id)
        if not recording:
            return False
        if user_id is not None and recording.user_id != user_id:
            raise PermissionError(f"user {user_id} does not own recording {recording_id}")
        recording.is_deleted = True
        await db.commit()
        # 清理原始文件
        try:
            delete_recording_file(recording.storage_path)
        except Exception:  # noqa: BLE001
            logger.exception("delete file failed for recording %s", recording_id)
        return True

    async def retranscribe(
        self,
        db: AsyncSession,
        recording_id: uuid.UUID,
        *,
        user_id: uuid.UUID | None = None,
    ) -> NoteRecording | None:
        """重置为 Uploaded 并清空转写，准备重跑；给定 user_id 时校验归属。"""
        recording = await self.get_recording_detail(db, recording_id)
        if not recording:
            return None
        if user_id is not None and recording.user_id != user_id:
            raise PermissionError(f"user {user_id} does not own recording {recording_id}")
        recording.status = "Uploaded"
        recording.progress_pct = 0
        recording.error_message = None
        await db.commit()

        # 清空旧 transcript 行
        from sqlalchemy import delete as sql_delete

        await db.execute(
            sql_delete(NoteTranscript)
            .where(NoteTranscript.recording_id == recording_id)
        )
        await db.commit()
        return await self.get_recording_detail(db, recording_id)