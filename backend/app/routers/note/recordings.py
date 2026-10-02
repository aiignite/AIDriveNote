"""笔记录音与语音转写路由。

提供富文本笔记「录音 / 上传 → 服务端转写 → 大模型整理」的后端接口：

    POST   /note-recordings                    上传音频并触发后台转写
    GET    /note-recordings                    按笔记或用户列出录音
    GET    /note-recordings/{id}               录音详情（含转写分段）
    GET    /note-recordings/{id}/transcript    转写状态与分段
    GET    /note-recordings/{id}/audio         音频流（支持签名直链播放）
    POST   /note-recordings/{id}/retranscribe  重新转写
    POST   /note-recordings/{id}/refine        重新做 LLM 整理 / 润色
    DELETE /note-recordings/{id}               软删除

音频播放说明：``<audio src>`` 无法携带 Authorization 头，因此 ``/audio``
接口同时接受「HMAC 签名查询参数 ``s``」与「登录态（Cookie/Bearer）」两种鉴权，
签名由 :func:`app.services.note.recording.signing.build_audio_url` 生成。
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.responses import FileResponse
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import _resolve_bearer_token, get_current_user
from app.config import get_settings
from app.database import get_db
from app.exceptions import (
    BadRequestException,
    ForbiddenException,
    NotFoundException,
)
from app.models.note.recording import NoteRecording, NoteTranscript
from app.models.user import User
from app.services.note.recording import (
    ALLOWED_EXTENSIONS,
    NoteAsrSettingsService,
    NoteRecordingService,
    NoteTranscriptionService,
    absolute_path,
    build_audio_url,
    safe_filename,
    verify_audio_signature,
)
from app.services.note.recording.transcript_refinement_service import (
    apply_refinement_to_recording,
)

router = APIRouter(prefix="/note-recordings", tags=["Note Recordings"])

logger = logging.getLogger(__name__)
settings = get_settings()

# 单例服务：实例本身很轻，重型状态（模型、信号量）位于类/模块级
_recording_service = NoteRecordingService()


# ── 序列化辅助 ────────────────────────────────────────────────────────

def _to_recording_out(recording: NoteRecording) -> dict[str, Any]:
    """把录音 ORM 对象序列化为响应字典（snake_case，前端统一转 camelCase）。

    ``audio_url`` 为后端算好的可直接播放地址（带 HMAC 签名）。
    """
    return {
        "id": str(recording.id),
        "note_id": str(recording.note_id) if recording.note_id else None,
        "user_id": str(recording.user_id) if recording.user_id else None,
        "file_name": recording.file_name,
        "file_size": recording.file_size,
        "duration_seconds": recording.duration_seconds,
        "mime_type": recording.mime_type,
        "status": recording.status,
        "progress_pct": recording.progress_pct,
        "language": recording.language,
        "model_size": recording.model_size,
        "error_message": recording.error_message,
        "audio_url": build_audio_url(str(recording.id)),
        "created_at": recording.created_at,
        "updated_at": recording.updated_at,
    }


def _to_segment_out(segment: NoteTranscript) -> dict[str, Any]:
    """把转写分段 ORM 对象序列化为响应字典。"""
    return {
        "id": str(segment.id),
        "segment_index": segment.segment_index,
        "start_time": segment.start_time,
        "end_time": segment.end_time,
        "speaker_label": segment.speaker_label,
        "text": segment.text,
        "confidence": segment.confidence,
        "language": segment.language,
        "chapter_id": segment.chapter_id,
        "chapter_title": segment.chapter_title,
        "keywords": segment.keywords,
    }


def _assert_recording_access(recording: NoteRecording, user: User) -> None:
    """校验录音归属：仅上传者本人可操作。"""
    if recording.user_id != user.id:
        raise ForbiddenException("Recording")


async def _optional_user(
    token_info: tuple[str | None, bool] = Depends(_resolve_bearer_token),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """尽力解析当前登录用户：未登录或凭证无效时返回 None（不抛 401）。

    音频流接口需要它——``<audio>`` 请求没有 Authorization 头时不能直接
    401 掉，否则浏览器无法播放带签名的直链。
    """
    token, _is_sso = token_info
    if not token:
        return None
    try:
        return await get_current_user(token_info=token_info, db=db)
    except HTTPException:
        return None


async def _run_transcription_safe(recording_id: uuid.UUID) -> None:
    """后台转写的兜底包装。

    ``NoteRecordingService.run_transcription`` 已内建大部分异常处理，这里再兜一层，
    确保任何未捕获异常都会把录音置为 ``Failed``，避免 UI 永久卡在 Transcribing。
    """
    try:
        await _recording_service.run_transcription(recording_id)
    except Exception as exc:  # noqa: BLE001 — 后台任务不允许异常冒泡到事件循环
        logger.exception("后台转写任务崩溃: %s", exc)
        try:
            from app.database import AsyncSessionLocal

            async with AsyncSessionLocal() as db:
                await db.execute(
                    update(NoteRecording)
                    .where(NoteRecording.id == recording_id)
                    .values(
                        status="Failed",
                        progress_pct=0,
                        error_message=f"unexpected: {exc}"[:2000],
                    )
                )
                await db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("兜底置 Failed 失败: %s", recording_id)


# ── 上传 / 列表 / 详情 ────────────────────────────────────────────────

@router.post("")
async def upload_recording(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    note_id: uuid.UUID | None = Form(default=None),
    transcripts: str | None = Form(
        default=None,
        description="浏览器内置 ASR 分段 JSON 数组：[{text,start_time,end_time}]，提供后跳过服务端 Whisper 直接落库",
    ),
    duration_seconds: float | None = Form(default=None, description="客户端上报的音频时长（秒）"),
    language: str | None = Form(default=None, description="识别语言，如 zh-CN"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """上传音频文件，创建录音记录。

    两种转写路径二选一：
    - 携带 ``transcripts``（浏览器 Web Speech API 结果）：直接落库并置为
      ``Transcribed``，不触发后台任务；
    - 未携带：走服务端 Whisper 流水线（remote 网关优先 / local 降级）。
    """
    import json

    file_name = safe_filename(file.filename or "recording")

    # 扩展名白名单校验（防止上传可执行文件）
    ext = Path(file_name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise BadRequestException(
            f"不支持的音频格式 {ext or '(无扩展名)'}，请上传 {'/'.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    try:
        recording = await _recording_service.create_recording(
            db,
            note_id=note_id,
            user_id=user.id,
            file_obj=file.file,
            file_name=file_name,
            mime_type=file.content_type,
            max_bytes=settings.NOTE_MAX_RECORDING_BYTES,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    except PermissionError as exc:
        raise ForbiddenException("Note") from exc

    # ── 路径 A：浏览器内置 ASR 分段随上传提交 → 直接落库，跳过 Whisper ──
    if transcripts:
        try:
            payload = json.loads(transcripts)
            if not isinstance(payload, list):
                raise ValueError("必须是数组")
        except (json.JSONDecodeError, ValueError) as exc:
            # 解析失败则回退到服务端转写路径，不阻塞上传本身
            logger.warning("浏览器分段解析失败，回退服务端转写: %s", exc)
        else:
            try:
                updated = await _recording_service.save_browser_transcripts(
                    db,
                    recording.id,
                    payload,
                    duration_seconds=duration_seconds,
                    language=language or "zh-CN",
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("浏览器分段落库失败: %s", exc)
                raise BadRequestException(f"浏览器分段落库失败：{exc}") from exc
            if updated is None:
                raise NotFoundException("Recording")
            return _to_recording_out(updated)

    # ── 路径 B：服务端 Whisper 流水线（remote 优先 / local 降级）──
    background_tasks.add_task(_run_transcription_safe, recording.id)
    return _to_recording_out(recording)


@router.get("")
async def list_recordings(
    note_id: uuid.UUID | None = Query(default=None),
    status: str | None = Query(default=None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """列出录音：指定 ``note_id`` 时按笔记过滤，否则列出当前用户全部录音。"""
    if note_id is not None:
        try:
            items = await _recording_service.list_recordings(
                db,
                note_id=note_id,
                user_id=user.id,
                limit=limit,
                offset=offset,
                status=status,
            )
        except PermissionError as exc:
            raise ForbiddenException("Note") from exc
    else:
        items = await _recording_service.list_user_recordings(
            db, user_id=user.id, limit=limit, offset=offset, status=status
        )

    # 仅返回属于当前用户的记录，避免越权读到他人上传
    owned = [r for r in items if r.user_id == user.id]
    return {"items": [_to_recording_out(r) for r in owned], "total": len(owned)}


@router.get("/{recording_id}")
async def get_recording(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """获取录音详情（含已生成的全部转写分段）。"""
    recording = await _recording_service.get_recording_detail(db, recording_id)
    if not recording:
        raise NotFoundException("Recording")
    _assert_recording_access(recording, user)

    segments = await _recording_service.get_full_transcript(db, recording_id)
    payload = _to_recording_out(recording)
    payload["transcripts"] = [_to_segment_out(s) for s in segments]
    return payload


@router.get("/{recording_id}/transcript")
async def get_recording_transcript(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """获取转写状态与分段，供前端 2 秒轮询。"""
    recording = await _recording_service.get_recording_detail(db, recording_id)
    if not recording:
        raise NotFoundException("Recording")
    _assert_recording_access(recording, user)

    segments = await _recording_service.get_full_transcript(db, recording_id)
    return {
        "status": recording.status,
        "progress_pct": recording.progress_pct,
        "error_message": recording.error_message,
        "segments": [_to_segment_out(s) for s in segments],
    }


@router.get("/{recording_id}/audio")
async def get_recording_audio(
    recording_id: uuid.UUID,
    s: str | None = Query(default=None, description="HMAC 音频直链签名"),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(_optional_user),
):
    """流式返回音频文件。

    鉴权二选一：签名参数 ``s`` 有效，或当前登录用户即为录音上传者。
    """
    recording = await _recording_service.get_recording_detail(db, recording_id)
    if not recording:
        raise NotFoundException("Recording")

    signed_ok = verify_audio_signature(str(recording_id), s)
    owner_ok = user is not None and recording.user_id == user.id
    if not (signed_ok or owner_ok):
        raise ForbiddenException("Recording audio")

    target = absolute_path(recording.storage_path)
    if not target.exists() or not target.is_file():
        raise NotFoundException("Recording audio file")

    return FileResponse(
        target,
        media_type=recording.mime_type or "application/octet-stream",
        filename=recording.file_name,
        # inline 让浏览器 <audio> 直接流式播放，而非触发下载
        content_disposition_type="inline",
    )


# ── 重转写 / 重润色 / 删除 ────────────────────────────────────────────

@router.post("/{recording_id}/retranscribe")
async def retranscribe_recording(
    recording_id: uuid.UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """重置录音状态并重新触发转写（失败时立即返回 400，不进入后台）。"""
    recording = await _recording_service.get_recording_detail(db, recording_id)
    if not recording:
        raise NotFoundException("Recording")
    _assert_recording_access(recording, user)

    # 可用性预检：避免进入后台后才发现缺依赖
    effective = await NoteAsrSettingsService.get_effective_settings(db)
    mode = effective.get("mode")
    if mode == "remote":
        reachable = await NoteTranscriptionService.remote_asr_reachable(db)
        if not reachable and not effective.get("fallback_to_local"):
            raise BadRequestException("远程 ASR 网关不可用，且未开启本机降级")
    elif not NoteTranscriptionService.ffmpeg_available():
        raise BadRequestException("本机模式需要 ffmpeg/ffprobe，请安装或切换为远程模式")

    try:
        updated = await _recording_service.retranscribe(db, recording_id, user_id=user.id)
    except PermissionError as exc:
        raise ForbiddenException("Recording") from exc
    if not updated:
        raise NotFoundException("Recording")

    background_tasks.add_task(_run_transcription_safe, recording_id)
    return _to_recording_out(updated)


@router.post("/{recording_id}/refine")
async def refine_recording(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """重新调用 LLM 对转写文本做去重 / 同音字修复 / 顺句 / 标点 / 分段。"""
    recording = await _recording_service.get_recording_detail(db, recording_id)
    if not recording:
        raise NotFoundException("Recording")
    _assert_recording_access(recording, user)

    try:
        await apply_refinement_to_recording(db, recording_id)
    except Exception as exc:  # noqa: BLE001 — 对外统一为可读的 400
        logger.warning("转写润色失败: %s", exc)
        raise BadRequestException(f"润色失败：{exc}") from exc

    refreshed = await _recording_service.get_recording_detail(db, recording_id)
    if not refreshed:
        raise NotFoundException("Recording")
    return _to_recording_out(refreshed)


@router.delete("/{recording_id}")
async def delete_recording(
    recording_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """软删除录音并清理磁盘文件。"""
    try:
        ok = await _recording_service.delete_recording(db, recording_id, user_id=user.id)
    except PermissionError as exc:
        raise ForbiddenException("Recording") from exc
    if not ok:
        raise NotFoundException("Recording")
    return {"ok": True}