"""基于 Whisper 的笔记录音转写服务。

职责：
    * 延迟加载 ``faster-whisper``（不在模块导入时导入，保证依赖缺失时
      应用仍能正常启动）。
    * 用 ``ffprobe`` 读取音频时长。
    * 用 ``ffmpeg silencedetect`` 在静音边界把长音频切成块，并带 60s 硬切兜底。
    * 通过 ``asyncio.to_thread`` 逐块运行 Whisper，避免阻塞事件循环。
    * 返回归一化分段列表 ``{start, end, text, confidence, language}``。

本模块不触碰数据库与路由——纯 CPU/IO 工作。

.. note::
   faster-whisper 基于 CTranslate2，在 CPU 上相对原版 openai-whisper 提速明显；
   模型权重与 openai-whisper 同源（首次调用会从 HF 下载）。
"""
from __future__ import annotations

import asyncio
import json
import logging

# 延迟导入以避免模块加载期的循环依赖。
# faster-whisper 第一次启动会从 HuggingFace 拉模型权重，国内经常 ConnectTimeout。
# 这里同时支持：
#   1) ``HF_ENDPOINT`` 环境变量（最优先，.env / start.sh 注入）
#   2) 默认走 hf-mirror.com（避免完全离线环境拿不到模型）
# 并在 import huggingface_hub 之前禁用 Xet，强制走经典 HTTP 下载（配合镜像）。
import os as _os
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.config import get_settings

if not _os.environ.get("HF_ENDPOINT"):
    _os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
_os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
# 拉大模型时默认 10s 太短，调到 60s
_os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class TranscriptSegment:
    """一个归一化后的 Whisper 分段。

    属性说明：
        start: 分段起始时间（秒）。
        end: 分段结束时间（秒）。
        text: 分段文本。
        confidence: 置信度（0-1，可为空）。
        speaker_label: 说话人标签（开启说话人分离时才有值）。
    """

    start: float
    end: float
    text: str
    confidence: float | None = None
    speaker_label: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """转为普通字典，便于 JSON 序列化。"""
        return asdict(self)


class NoteTranscriptionError(RuntimeError):
    """转写流水线无法继续时抛出。"""


class NoteTranscriptionService:
    """围绕 Whisper + ffmpeg 的无状态门面。

    单个实例可跨请求复用；Whisper 模型在首次使用时缓存；
    ``transcribe`` 对异步友好，因为重型工作运行在 ``asyncio.to_thread`` 中。
    """

    def __init__(
        self,
        model_size: str | None = None,
        language: str | None = None,
        db: Any | None = None,
    ) -> None:
        """依据环境配置初始化；传入 ``db`` 时会尝试用数据库设置覆盖默认值。"""
        settings = get_settings()
        self._model_size = model_size or settings.NOTE_WHISPER_MODEL
        self._language = (language or settings.NOTE_WHISPER_LANGUAGE) or None
        self._max_concurrent = max(1, settings.NOTE_WHISPER_MAX_CONCURRENT)
        self._silence_db = float(settings.NOTE_SPLIT_SILENCE_DB)
        self._silence_duration = float(settings.NOTE_SPLIT_SILENCE_DURATION)
        self._max_segment_seconds = max(5, int(settings.NOTE_SPLIT_MAX_SEGMENT_SECONDS))
        # 最小窗口：silencedetect 经常切出 0.5-1s 的“非沉默”碎片，
        # 送进 Whisper 必然返回空，导致长录音末尾的语音被切碎漏掉。
        self._min_segment_seconds = max(0.5, float(settings.NOTE_SPLIT_MIN_SEGMENT_SECONDS))
        self._enable_diarization = bool(settings.NOTE_ENABLE_SPEAKER_DIARIZATION)
        self._asr_mode = (settings.NOTE_ASR_MODE or "local").strip().lower()
        self._fallback_local = bool(settings.NOTE_ASR_FALLBACK_LOCAL)
        self._device = (settings.NOTE_WHISPER_DEVICE or "cpu").strip() or "cpu"
        self._compute_type = (settings.NOTE_WHISPER_COMPUTE_TYPE or "int8").strip() or "int8"
        self._remote_url = settings.NOTE_ASR_REMOTE_URL or ""
        self._remote_api_key = settings.NOTE_ASR_REMOTE_API_KEY or ""
        self._remote_timeout = max(30, int(settings.NOTE_ASR_REMOTE_TIMEOUT or 3600))
        self._semaphore = asyncio.Semaphore(self._max_concurrent)
        self._whisper = None  # 延迟加载
        self._db = db

        # 运行时数据库设置优先于环境默认值。``__init__`` 是同步的；若传入
        # 异步会话且当前没有运行中的事件循环，可以阻塞加载设置。在异步上下文
        # 中请改用 :meth:`create`。
        if db is not None:
            try:
                self._apply_db_settings_sync(db)
            except Exception as exc:  # noqa: BLE001
                logger.warning("failed to apply DB ASR settings, using env defaults: %s", exc)

    @classmethod
    async def create(
        cls,
        db: Any,
        model_size: str | None = None,
        language: str | None = None,
    ) -> NoteTranscriptionService:
        """异步工厂：返回实例前先应用数据库设置。

        在异步函数内部构造服务时使用此方法。
        """
        instance = cls(model_size=model_size, language=language)
        await instance._apply_db_settings_async(db)
        return instance

    def _apply_db_settings_sync(self, db: Any) -> None:
        """应用数据库设置的同步入口（仅在无运行中事件循环时可用）。"""
        import asyncio

        from app.services.note.recording.asr_settings_service import NoteAsrSettingsService

        row = NoteAsrSettingsService.get_settings(db)
        if hasattr(row, "__await__"):
            loop = asyncio.get_event_loop()
            if loop.is_running():
                raise RuntimeError("async session requires async factory NoteTranscriptionService.create")
            row = loop.run_until_complete(row)
        if row is None:
            return
        self._apply_row_settings(row, db)

    async def _apply_db_settings_async(self, db: Any) -> None:
        """应用数据库设置的异步入口。"""
        from app.services.note.recording.asr_settings_service import NoteAsrSettingsService

        row = await NoteAsrSettingsService.get_settings(db)
        if row is None:
            return
        effective = await NoteAsrSettingsService.get_effective_settings(db)
        self._apply_effective_settings(row, effective)

    def _apply_row_settings(self, row: Any, db: Any) -> None:
        """把解析出的数据库行值覆盖到环境默认值之上（同步路径可能阻塞）。"""
        from app.services.note.recording.asr_settings_service import NoteAsrSettingsService

        effective = NoteAsrSettingsService.get_effective_settings(db)
        if hasattr(effective, "__await__"):
            import asyncio

            loop = asyncio.get_event_loop()
            if loop.is_running():
                raise RuntimeError("async session requires async factory NoteTranscriptionService.create")
            effective = loop.run_until_complete(effective)
        self._apply_effective_settings(row, effective)  # type: ignore[reportArgumentType]  类型修复

    def _apply_effective_settings(
        self, row: Any, effective: dict[str, Any]
    ) -> None:
        """把解析后的最终设置覆盖到环境默认值之上。"""
        from app.services.note.recording.asr_settings_service import NoteAsrSettingsService

        self._model_size = effective.get("model") or self._model_size
        self._language = effective.get("language") or self._language
        self._asr_mode = effective.get("mode") or self._asr_mode
        self._remote_url = effective.get("remote_url") or self._remote_url
        self._remote_api_key = (
            NoteAsrSettingsService.decrypt_remote_api_key(row) or self._remote_api_key
        )
        self._remote_timeout = max(
            30, int(effective.get("remote_timeout_seconds") or self._remote_timeout)
        )
        self._fallback_local = bool(
            effective.get("fallback_to_local")
            if effective.get("fallback_to_local") is not None
            else self._fallback_local
        )
        self._device = effective.get("device") or self._device
        self._compute_type = effective.get("compute_type") or self._compute_type

    # ── 公开接口 ────────────────────────────────────────────────────────

    async def transcribe(
        self,
        storage_path: str,
        progress_callback=None,
    ) -> list[TranscriptSegment]:
        """转写一条已存储录音，返回有序分段列表。"""
        target = self._resolve_absolute(storage_path)
        if not target.exists():
            raise NoteTranscriptionError(f"recording file not found: {storage_path}")

        if self._asr_mode == "remote":
            try:
                async with self._semaphore:
                    return await self._transcribe_remote(target, progress_callback)
            except Exception as exc:  # noqa: BLE001
                if not self._fallback_local:
                    if isinstance(exc, NoteTranscriptionError):
                        raise
                    raise NoteTranscriptionError(f"remote ASR failed: {exc}") from exc
                logger.warning(
                    "remote ASR failed, falling back to local: %s", exc
                )

        if not self._ffmpeg_available():
            raise NoteTranscriptionError(
                "ffmpeg/ffprobe not installed — cannot run transcription"
            )

        async with self._semaphore:
            return await self._transcribe_locked(target, progress_callback)

    async def _transcribe_remote(
        self,
        target: Path,
        progress_callback,
    ) -> list[TranscriptSegment]:
        """远程 GPU 网关转写路径。"""
        import asyncio

        from app.services.note.recording.asr_remote_client import (
            NoteAsrRemoteClient,
            NoteAsrRemoteError,
        )

        client = NoteAsrRemoteClient(
            url=self._remote_url,
            api_key=self._remote_api_key,
            timeout_seconds=self._remote_timeout,
        )

        def _pct(pct: int) -> None:
            if progress_callback is None:
                return
            try:
                progress_callback(pct)
            except Exception:  # noqa: BLE001
                logger.debug("progress_callback raised", exc_info=True)

        _pct(5)
        # Windows GPU 主机常缺 ffmpeg；先在这里把 webm/mp4 转为 16k wav。
        upload_path = target
        tmp_wav: Path | None = None
        if target.suffix.lower() != ".wav":
            if not self._ffmpeg_available():
                raise NoteTranscriptionError(
                    "ffmpeg required to convert recording before remote ASR upload"
                )
            tmp_wav = target.with_suffix(".remote-16k.wav")
            await asyncio.to_thread(self._ffmpeg_to_wav_16k, target, tmp_wav)
            if not tmp_wav.exists() or tmp_wav.stat().st_size == 0:
                raise NoteTranscriptionError("ffmpeg conversion to wav failed for remote ASR")
            upload_path = tmp_wav
            _pct(10)

        logger.info(
            "remote ASR upload start: %s (%.1f MB) -> %s",
            upload_path.name,
            upload_path.stat().st_size / (1024 * 1024),
            self._remote_url,
        )

        # 等待 GPU 主机期间发心跳（远程路径没有分块进度）。
        stop_hb = asyncio.Event()

        async def _heartbeat() -> None:
            pct = 12
            while not stop_hb.is_set():
                try:
                    await asyncio.wait_for(stop_hb.wait(), timeout=15.0)
                    return
                except TimeoutError:
                    pct = min(90, pct + 3)
                    _pct(pct)

        hb_task = asyncio.create_task(_heartbeat())
        try:
            try:
                raw = await client.transcribe_file(
                    upload_path,
                    language=self._language,
                    model_size=self._model_size,
                )
            except NoteAsrRemoteError as exc:
                raise NoteTranscriptionError(str(exc)) from exc
        finally:
            stop_hb.set()
            try:
                await hb_task
            except Exception:  # noqa: BLE001
                pass
            if tmp_wav is not None:
                try:
                    tmp_wav.unlink(missing_ok=True)
                except OSError:
                    pass

        _pct(95)

        segments = [
            TranscriptSegment(
                start=round(float(item.get("start", 0)), 3),
                end=round(float(item.get("end", 0)), 3),
                text=str(item.get("text") or "").strip(),
                confidence=item.get("confidence"),
            )
            for item in raw
            if str(item.get("text") or "").strip()
        ]
        if not segments:
            raise NoteTranscriptionError("remote ASR returned no text segments")
        _pct(100)
        logger.info(
            "remote ASR done: %d segments (file=%s)",
            len(segments),
            target.name,
        )
        return segments

    @staticmethod
    def asr_mode(db: Any | None = None) -> str:
        """返回生效的 ASR 模式，优先使用数据库设置。

        若提供 ``db``，会尝试读取已保存的模式。由于此方法是同步的，异步会话
        只有在当前没有运行中的事件循环时才能被 await；异步上下文中会安全回退
        到环境默认值。
        """
        if db is not None:
            try:
                from app.services.note.recording.asr_settings_service import (
                    NoteAsrSettingsService,
                )

                row = NoteAsrSettingsService.get_settings(db)
                # db 为异步会话时 row 是可等待对象
                if hasattr(row, "__await__"):
                    import asyncio

                    try:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            # 无法在运行中的循环内同步 await
                            raise RuntimeError("async session requires async caller")
                        row = loop.run_until_complete(row)
                    except RuntimeError:
                        row = None
                if row is not None:
                    return row.mode
            except Exception as exc:  # noqa: BLE001
                logger.debug("failed to read ASR mode from DB: %s", exc)
        return (get_settings().NOTE_ASR_MODE or "local").strip().lower()

    @staticmethod
    async def remote_asr_reachable(db: Any | None = None) -> bool:
        """mode=remote 时的尽力健康探测。

        若提供 ``db``，则优先使用数据库中配置的远程 URL/API Key；
        否则使用环境变量。
        """
        from app.services.note.recording.asr_settings_service import NoteAsrSettingsService

        mode = "local"
        url = ""
        api_key = ""
        timeout = 3600
        if db is not None:
            try:
                effective = await NoteAsrSettingsService.get_effective_settings(db)
                mode = effective.get("mode", "local")
                url = effective.get("remote_url") or ""
                api_key = effective.get("remote_api_key") or ""
                timeout = int(effective.get("remote_timeout_seconds") or 3600)
                # 若 Key 来自加密列，需解密。
                row = await NoteAsrSettingsService.get_settings(db)
                decrypted = NoteAsrSettingsService.decrypt_remote_api_key(row)
                if decrypted:
                    api_key = decrypted
            except Exception as exc:  # noqa: BLE001
                logger.debug("failed to read remote ASR settings from DB: %s", exc)

        if mode != "remote":
            settings = get_settings()
            mode = (settings.NOTE_ASR_MODE or "local").strip().lower()
            url = settings.NOTE_ASR_REMOTE_URL or ""
            api_key = settings.NOTE_ASR_REMOTE_API_KEY or ""
            timeout = max(30, int(settings.NOTE_ASR_REMOTE_TIMEOUT or 3600))

        if mode != "remote":
            return True
        if not url.strip():
            return False
        from app.services.note.recording.asr_remote_client import NoteAsrRemoteClient

        try:
            client = NoteAsrRemoteClient(
                url=url,
                api_key=api_key,
                timeout_seconds=timeout,
            )
            return await client.health_check()
        except Exception:  # noqa: BLE001
            return False

    # ── 预检辅助 ────────────────────────────────────────────────────────

    @staticmethod
    def ffmpeg_available() -> bool:
        """ffmpeg 与 ffprobe 是否都在 PATH 上。"""
        return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None

    def _ffmpeg_available(self) -> bool:
        """实例方法包装，便于测试打桩。"""
        return self.ffmpeg_available()

    @staticmethod
    def probe_duration_seconds(storage_path: str) -> int:
        """返回音频时长（秒），失败返回 -1。"""
        target = NoteTranscriptionService._resolve_absolute(storage_path)
        if not target.exists():
            return -1
        try:
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(target),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return -1
        if result.returncode != 0:
            return -1
        try:
            return int(float((result.stdout or "").strip()))
        except (TypeError, ValueError):
            return -1

    @staticmethod
    def _resolve_absolute(storage_path: str) -> Path:
        """把相对 backend/ 的存储路径解析为绝对路径。"""
        backend_root = Path(__file__).resolve().parents[4]
        return (backend_root / storage_path).resolve()

    # ── 核心流水线 ──────────────────────────────────────────────────────

    async def _transcribe_locked(self, target: Path, progress_callback) -> list[TranscriptSegment]:
        """本地 Whisper 转写主流程（切分 → 逐块转写 → 时间戳回填）。"""
        duration = await asyncio.to_thread(self.probe_duration_seconds, str(target))
        if duration is None or duration < 0:
            duration = 0

        chunks: list[tuple[float, float, Path]] = []
        with tempfile.TemporaryDirectory(prefix="note_chunks_") as tmp:
            tmp_dir = Path(tmp)
            chunks = await asyncio.to_thread(
                self._split_audio_into_chunks, target, tmp_dir, duration
            )
            if not chunks:
                # 兜底：整段作为单个分块
                chunks = [(0.0, float(duration or 0), target)]

            segments: list[TranscriptSegment] = []
            total = len(chunks) or 1
            chunk_errors: list[str] = []
            # ── 说话人识别（默认关闭；伪 VAD 会产生大量 Speaker N）──
            turns: list = []
            if self._enable_diarization:
                try:
                    from app.services.note.recording.diarization_service import (
                        DiarizationService,
                    )
                    turns, used = await DiarizationService().diarize(
                        str(target), language=self._language,
                    )
                    logger.info("diarization used=%s → %d turns", used, len(turns))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("diarization skipped: %s", exc)

            for idx, (start, _end, chunk_path) in enumerate(chunks):
                try:
                    chunk_segments = await asyncio.to_thread(
                        self._whisper_transcribe_chunk, chunk_path
                    )
                except NoteTranscriptionError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    logger.warning("whisper chunk %d failed: %s", idx, exc)
                    chunk_errors.append(str(exc))
                    continue

                # 把时间戳回填到原始时间轴 + 写入 speaker_label
                for seg in chunk_segments:
                    abs_start = start + float(seg.get("start", 0))
                    abs_end = start + float(seg.get("end", 0))
                    label = None
                    if turns:
                        from app.services.note.recording.diarization_service import (
                            assign_speaker_label,
                        )
                        label = assign_speaker_label(abs_start, abs_end, turns)
                    segments.append(
                        TranscriptSegment(
                            start=round(abs_start, 3),
                            end=round(abs_end, 3),
                            text=str(seg.get("text") or "").strip(),
                            confidence=seg.get("confidence"),
                            speaker_label=label,
                        )
                    )

                if progress_callback is not None:
                    try:
                        progress_callback(int((idx + 1) * 100 / total))
                    except Exception:  # noqa: BLE001
                        logger.debug("progress_callback raised", exc_info=True)

        # 丢弃空分段
        if not segments and chunk_errors:
            raise NoteTranscriptionError(
                f"all {len(chunks)} whisper chunks failed: {chunk_errors[0][:200]}"
            )
        return [s for s in segments if s.text]

    # ── ffmpeg 辅助（同步） ─────────────────────────────────────────────

    def _split_audio_into_chunks(
        self, target: Path, work_dir: Path, total_duration: int
    ) -> list[tuple[float, float, Path]]:
        """用 silencedetect 计算切分点，再用 ``ffmpeg`` 切片。"""
        silence_points = self._detect_silence_points(target)
        windows = self._build_windows(silence_points, total_duration)
        chunks: list[tuple[float, float, Path]] = []
        for idx, (start, end) in enumerate(windows):
            chunk_path = work_dir / f"chunk_{idx:04d}.wav"
            self._ffmpeg_extract_segment(target, chunk_path, start, end)
            if chunk_path.exists() and chunk_path.stat().st_size > 0:
                chunks.append((start, end, chunk_path))
        return chunks

    def _detect_silence_points(self, target: Path) -> list[float]:
        """返回静音达到阈值的（中点）时间戳列表。"""
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostats",
                    "-i",
                    str(target),
                    "-af",
                    f"silencedetect=noise={self._silence_db}dB:d={self._silence_duration}",
                    "-f",
                    "null",
                    "-",
                ],
                capture_output=True,
                text=True,
                timeout=600,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            logger.warning("silencedetect failed: %s", exc)
            return []

        output = (result.stderr or "") + (result.stdout or "")
        # 解析 silencedetect 输出的 silence_start / silence_end
        points: list[float] = []
        starts: list[float] = []
        ends: list[float] = []
        for line in output.splitlines():
            if "silence_start:" in line:
                try:
                    starts.append(float(line.rsplit(":", 1)[-1].strip()))
                except ValueError:
                    continue
            elif "silence_end:" in line:
                # 形如: "[silencedetect @ 0x...] silence_end: 12.345 | silence_duration: 0.6"
                try:
                    head = line.rsplit("silence_end:", 1)[-1].strip()
                    head = head.split("|", 1)[0].strip()
                    ends.append(float(head))
                except ValueError:
                    continue

        for s, e in zip(starts, ends, strict=False):
            points.append((s + e) / 2.0)
        return points

    def _build_windows(self, silence_points: list[float], total_duration: int) -> list[tuple[float, float]]:
        """围绕静音中点组合互不重叠的窗口。

        同时施加 ``max_segment_seconds`` 硬上限与 ``min_segment_seconds`` 下限
        （过短的碎片向前合并进上一个窗口，让 Whisper 拿到有意义的输入）。
        """
        total = float(total_duration or 0)
        if total <= 0:
            # 退化为单窗口
            return [(0.0, max(float(self._max_segment_seconds), 1.0))]

        # 构造切分边界
        boundaries = [0.0]
        for mid in silence_points:
            if 0.0 < mid < total:
                boundaries.append(mid)
        boundaries.append(total)
        boundaries.sort()

        # 由相邻边界成对组合出原始窗口
        raw_windows: list[tuple[float, float]] = []
        for a, b in zip(boundaries[:-1], boundaries[1:], strict=False):
            if b - a <= 0.05:
                continue
            # 强制切分到 max_segment_seconds 以内
            sub_start = a
            while sub_start < b:
                sub_end = min(sub_start + self._max_segment_seconds, b)
                raw_windows.append((sub_start, sub_end))
                sub_start = sub_end

        # 合并短于 _min_segment_seconds 的窗口到上一个，
        # 避免 silencedetect 切出的 0.5-1s 碎片进 Whisper 后被丢成空段。
        if not raw_windows:
            return [(0.0, total)]

        merged: list[tuple[float, float]] = [raw_windows[0]]
        for cur in raw_windows[1:]:
            a, b = merged[-1]
            ca, cb = cur
            if (cb - ca) < self._min_segment_seconds:
                # 当前窗口太短 → 把它并入上一个
                merged[-1] = (a, max(b, cb))
            else:
                merged.append(cur)

        # 若合并后第一个窗口仍然太短（极端：silence 列表把开头切碎），
        # 退化为整段单窗口，让 Whisper 自行 VAD。
        if merged and (merged[0][1] - merged[0][0]) < self._min_segment_seconds:
            return [(0.0, total)]

        return merged

    def _ffmpeg_to_wav_16k(self, src: Path, dst: Path) -> None:
        """将整段文件转为 16kHz 单声道 PCM WAV（用于远程 ASR 上传）。"""
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-nostats",
                    "-i",
                    str(src),
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(dst),
                ],
                capture_output=True,
                text=True,
                timeout=600,
                check=True,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
            logger.warning("ffmpeg wav convert failed (%s): %s", src.name, exc)
            if dst.exists():
                try:
                    dst.unlink()
                except OSError:
                    pass

    def _ffmpeg_extract_segment(
        self, src: Path, dst: Path, start: float, end: float
    ) -> None:
        """从源文件切出一段 16kHz 单声道 PCM WAV。"""
        duration = max(end - start, 0.05)
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-nostats",
                    "-ss",
                    f"{start:.3f}",
                    "-i",
                    str(src),
                    "-t",
                    f"{duration:.3f}",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-c:a",
                    "pcm_s16le",
                    str(dst),
                ],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            logger.warning("ffmpeg extract failed (%s): %s", dst.name, exc)
            return
        if not dst.exists() or dst.stat().st_size == 0:
            logger.debug("ffmpeg produced empty chunk: %s", dst)

    # ── whisper 辅助（同步，在线程中运行） ──────────────────────────────

    def _get_whisper(self):  # type: ignore[no-untyped-def]
        """延迟加载 faster-whisper 模型。

        faster-whisper 返回的 :class:`WhisperModel` 的 ``transcribe`` 返回
        ``(segments_iter, info)``；分段迭代器产出带 ``start``、``end``、
        ``text``、``avg_logprob``（用作置信度代理）的对象。
        """
        if self._whisper is None:
            try:
                from faster_whisper import WhisperModel  # type: ignore[import-not-found]
            except ImportError as exc:  # pragma: no cover - 取决于运行环境
                raise NoteTranscriptionError(
                    "faster-whisper is not installed; run `pip install -U faster-whisper`"
                ) from exc

            # CPU + int8 在精度几乎无损下显著降低内存并加速。
            # GPU 机可设 NOTE_WHISPER_DEVICE=cuda / NOTE_WHISPER_COMPUTE_TYPE=float16。
            self._whisper = WhisperModel(
                self._model_size,
                device=self._device,
                compute_type=self._compute_type,
            )
            logger.info(
                "faster-whisper model loaded: %s (device=%s, compute_type=%s)",
                self._model_size, self._device, self._compute_type,
            )
        return self._whisper

    def _whisper_transcribe_chunk(self, chunk_path: Path) -> list[dict[str, Any]]:
        """转写单个音频分块。"""
        model = self._get_whisper()
        # faster-whisper 调用约定：
        #   segments_iter, info = model.transcribe(audio, ...)
        # 我们已经做过 silencedetect 切分，所以 vad_filter=False 避免重复。
        # beam_size=1 提速明显，对中文场景精度损失可接受。
        # condition_on_previous_text=False 避免长录音重复上下文导致 attention 变慢。
        segments_iter, _info = model.transcribe(  # type: ignore[union-attr]
            str(chunk_path),
            language=self._language,
            beam_size=1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        out: list[dict[str, Any]] = []
        for seg in segments_iter:
            text = (seg.text or "").strip()
            if not text:
                continue
            out.append(
                {
                    "start": float(seg.start or 0),
                    "end": float(seg.end or 0),
                    "text": text,
                    # faster-whisper 的 avg_logprob 越大越好（典型 -1.0 ~ 0.0）
                    "confidence": self._map_logprob_to_conf(getattr(seg, "avg_logprob", None)),
                }
            )
        return out

    @staticmethod
    def _map_logprob_to_conf(avg_logprob: float | None) -> float | None:
        """faster-whisper 没有分段置信度；用 avg_logprob 估算。

        经验映射：avg_logprob ∈ [-1.0, 0] → confidence ∈ [0, 1]。
        """
        if avg_logprob is None:
            return None
        try:
            v = float(avg_logprob)
        except (TypeError, ValueError):
            return None
        return round(max(0.0, min(1.0, v + 1.0)), 4)

    # ── 序列化 ──────────────────────────────────────────────────────────

    @staticmethod
    def segments_to_json(segments: list[TranscriptSegment]) -> str:
        """把分段列表序列化为 JSON 字符串。"""
        return json.dumps([s.to_dict() for s in segments], ensure_ascii=False)