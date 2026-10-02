"""说话人分离服务——多策略适配器。

按能力与外部依赖成本依次尝试三种实现：

1. ``QwenDiarizer``     — 阿里通义听悟（paraformer-realtime-v2 + 说话人
   分离）。中文 ASR 最佳且有原生说话人标签，需要
   ``DASHSCOPE_API_KEY`` 环境变量。返回 ``Speaker_NN`` 标签与每轮置信度。
2. ``PyannoteDiarizer``  — pyannote-audio pipeline 3.1。需要 HF token +
   pipeline 模型权重。当前**默认未安装**；若用户已安装则适配器启用，
   否则回退到策略 3。
3. ``EnergyVADDiarizer`` — 零依赖兜底。用 ``ffmpeg silencedetect`` 在静音
   边界切分音频，并用递增计数器（Speaker 1, Speaker 2, …）标注每个非静音
   切片。廉价且确定。

三者都返回 :class:`SpeakerTurn` 记录列表，含 ``start``、``end``（秒）与
``speaker_label``（字符串）。调用方（主要是转写服务）把这些 turn 与
Whisper 分段求交，填入 ``speaker_label``。
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

logger = logging.getLogger(__name__)


def diarization_enabled() -> bool:
    """是否启用说话人分离（由 ``NOTE_ENABLE_SPEAKER_DIARIZATION`` 控制，默认关闭）。"""
    from app.config import get_settings
    try:
        return bool(get_settings().NOTE_ENABLE_SPEAKER_DIARIZATION)
    except Exception:  # noqa: BLE001  配置异常时保守关闭
        return False


@dataclass(slots=True)
class SpeakerTurn:
    """由一个说话人占据的连续时间区间。

    属性说明：
        start/end: 起止时间（秒）。
        speaker_label: 说话人标签（如 "Speaker 1" 或 "qwen:S1"）。
        confidence: 置信度（0..1；仅云端 provider 会设置）。
    """

    start: float
    end: float
    speaker_label: str  # "Speaker 1" 或解析后的 "user:<uuid>"
    confidence: float = 1.0

    def to_dict(self) -> dict:
        """转为普通字典。"""
        return {
            "start": self.start,
            "end": self.end,
            "speaker_label": self.speaker_label,
            "confidence": self.confidence,
        }


class Diarizer(Protocol):
    """说话人分离适配器协议。"""

    name: str

    async def diarize(
        self, storage_path: str, language: str | None = None
    ) -> list[SpeakerTurn]: ...


def _resolve_absolute(storage_path: str) -> Path:
    """把相对 backend/ 的存储路径解析为绝对路径。"""
    backend_root = Path(__file__).resolve().parents[4]
    return (backend_root / storage_path).resolve()


# ────────────────────────────────────────────────────────────────────
# 3) 能量 / 静音兜底（始终可用）
# ────────────────────────────────────────────────────────────────────


class EnergyVADDiarizer:
    """通过 ffmpeg silencedetect 做粗粒度说话人切分。

    这**并非**真正的说话人分离——它无法分辨*谁*在说话，只能判断*有人*在
    说话。它是始终可用的兜底，让 UI 至少能显示 "Speaker 1 / 2 / 3" 色条，
    而不是空标签。
    """

    name = "energy-vad"

    def __init__(self, *, min_turn_seconds: float = 1.0) -> None:
        # 最短 turn 时长（秒），过短会被忽略
        self.min_turn_seconds = max(0.1, float(min_turn_seconds))

    async def diarize(
        self, storage_path: str, language: str | None = None
    ) -> list[SpeakerTurn]:
        """基于静音区间估算说话区间并递增标注 Speaker N。"""
        if shutil.which("ffmpeg") is None:
            logger.warning("EnergyVADDiarizer: ffmpeg not available; emitting single Speaker 1 turn")
            return [SpeakerTurn(start=0.0, end=0.0, speaker_label="Speaker 1", confidence=0.0)]

        target = _resolve_absolute(storage_path)
        if not target.exists():
            return []

        # silencedetect 会把 silence_start / silence_end 写到 stderr。
        # 解析沉默区间，再补出说话区间。
        try:
            result = subprocess.run(  # noqa: ASYNC221  async 中 subprocess 调用（框架限制）
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostats",
                    "-i",
                    str(target),
                    "-af",
                    "silencedetect=noise=-30dB:d=0.5",
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
            return [SpeakerTurn(start=0.0, end=0.0, speaker_label="Speaker 1", confidence=0.0)]

        output = (result.stderr or "") + (result.stdout or "")
        silences: list[tuple[float, float]] = []
        starts: list[float] = []
        ends: list[float] = []
        for line in output.splitlines():
            if "silence_start:" in line:
                try:
                    starts.append(float(line.rsplit(":", 1)[-1].strip()))
                except ValueError:
                    continue
            elif "silence_end:" in line:
                try:
                    head = line.rsplit("silence_end:", 1)[-1].strip()
                    head = head.split("|", 1)[0].strip()
                    ends.append(float(head))
                except ValueError:
                    continue

        for s, e in zip(starts, ends, strict=False):
            silences.append((s, e))

        # 估计总时长（用 ffprobe 拿真实 duration）
        total = self._probe_duration(target)

        # 沉默 → 说话区间
        speech: list[tuple[float, float]] = []
        cursor = 0.0
        for s, e in silences:
            if s - cursor >= 0.1:
                speech.append((cursor, s))
            cursor = max(cursor, e)
        if total - cursor >= 0.1:
            speech.append((cursor, total))

        if not speech:
            return [SpeakerTurn(0.0, total or 0.0, "Speaker 1", 0.0)]

        # 这里没真说话人识别；只是给每段标个递增的 Speaker N
        turns: list[SpeakerTurn] = []
        idx = 1
        for s, e in speech:
            turns.append(SpeakerTurn(start=s, end=e, speaker_label=f"Speaker {idx}"))
            idx += 1
        return turns

    @staticmethod
    def _probe_duration(target: Path) -> float:
        """用 ffprobe 探测音频总时长（秒）；失败返回 0.0。"""
        try:
            r = subprocess.run(
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
                timeout=15,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return 0.0
        try:
            return float((r.stdout or "").strip())
        except ValueError:
            return 0.0


# ────────────────────────────────────────────────────────────────────
# 2) pyannote（可选，延迟加载）
# ────────────────────────────────────────────────────────────────────


class PyannoteDiarizer:
    """基于 pyannote-audio 3.1 的说话人分离。

    依赖：
        * 已安装 ``pyannote.audio``
        * 可访问 ``pyannote/speaker-diarization-3.1`` 的 HuggingFace token
        * 通过 ``PYANNOTE_AUTH_TOKEN`` 环境变量提供 token

    任一条件缺失时，适配器抛出 :class:`DiarizationUnavailable`，
    让编排器回退到下一个策略。
    """

    name = "pyannote"

    def __init__(self, *, auth_token: str | None = None) -> None:
        # HF 访问 token；为空时读取环境变量
        self._auth_token = auth_token or os.getenv("PYANNOTE_AUTH_TOKEN")
        self._pipeline = None  # 延迟加载

    def _ensure_pipeline(self):
        """延迟加载并缓存 pyannote pipeline。"""
        if self._pipeline is not None:
            return self._pipeline
        try:
            from pyannote.audio import Pipeline  # type: ignore[import-not-found]
        except ImportError as exc:
            raise DiarizationUnavailable("pyannote.audio not installed") from exc
        if not self._auth_token:
            raise DiarizationUnavailable("PYANNOTE_AUTH_TOKEN env var not set")
        self._pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=self._auth_token,
        )
        return self._pipeline

    async def diarize(
        self, storage_path: str, language: str | None = None
    ) -> list[SpeakerTurn]:
        """在线程中运行 pyannote（其 API 为同步）。"""
        # pyannote API 是同步的；放到线程里跑以免阻塞事件循环
        import asyncio
        target = _resolve_absolute(storage_path)
        if not target.exists():
            return []

        def _run() -> list[SpeakerTurn]:
            pipeline = self._ensure_pipeline()
            diarization = pipeline(str(target))
            turns: list[SpeakerTurn] = []
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                turns.append(
                    SpeakerTurn(
                        start=float(turn.start),
                        end=float(turn.end),
                        speaker_label=f"pyannote:{speaker}",
                        confidence=0.9,
                    )
                )
            return turns

        return await asyncio.to_thread(_run)


# ────────────────────────────────────────────────────────────────────
# 1) Qwen / 通义听悟（可选，云端）
# ────────────────────────────────────────────────────────────────────


class QwenDiarizer:
    """阿里云通义听悟——ASR + 说话人分离（paraformer-realtime-v2）。

    需要 ``DASHSCOPE_API_KEY`` 环境变量。返回带 ``S1`` / ``S2`` 说话人 id
    的 turn 列表。
    """

    name = "qwen-tingwu"

    def __init__(self, *, api_key: str | None = None) -> None:
        # 阿里云 DashScope API Key
        self._api_key = api_key or os.getenv("DASHSCOPE_API_KEY")
        self._sdk = None  # 延迟加载

    def _ensure_sdk(self):
        """延迟加载并缓存 dashscope SDK。"""
        if self._sdk is not None:
            return self._sdk
        if not self._api_key:
            raise DiarizationUnavailable("DASHSCOPE_API_KEY env var not set")
        try:
            import dashscope  # type: ignore[import-not-found]
            from dashscope.audio.asr import Recognition  # type: ignore[import-not-found]
        except ImportError as exc:
            raise DiarizationUnavailable("dashscope SDK not installed") from exc
        dashscope.api_key = self._api_key
        self._sdk = dashscope
        self._recognition_cls = Recognition
        return dashscope

    async def diarize(
        self, storage_path: str, language: str | None = None
    ) -> list[SpeakerTurn]:
        """把本地文件交给通义听悟做说话人分离。"""
        # 通义支持本地文件直接传；这里走 file_urls 形式
        target = _resolve_absolute(storage_path)
        if not target.exists():
            return []
        sdk = self._ensure_sdk()
        return await _run_in_thread(self._diarize_sync, sdk, target, language)

    @staticmethod
    def _diarize_sync(sdk, target: Path, language: str | None) -> list[SpeakerTurn]:
        """同步调用通义听悟并把结果映射为 SpeakerTurn。"""
        try:
            response = sdk.audio.asr.Recognition.call(
                model="paraformer-realtime-v2",
                file_urls=[f"file://{target}"],
                language_hints=[language] if language else [],
                diarization_enabled=True,
            )
        except Exception as exc:  # noqa: BLE001
            raise DiarizationUnavailable(f"qwen call failed: {exc}") from exc
        if not response or getattr(response, "output", None) is None:
            return []
        out: list[SpeakerTurn] = []
        sentences = (response.output.sentences or []) if hasattr(response.output, "sentences") else []
        for s in sentences:
            speaker = getattr(s, "speaker_id", None) or "S1"
            start = float(getattr(s, "begin_time", 0) or 0) / 1000.0
            end = float(getattr(s, "end_time", 0) or 0) / 1000.0
            confidence = float(getattr(s, "confidence", 0) or 0)
            out.append(
                SpeakerTurn(
                    start=start,
                    end=end,
                    speaker_label=f"qwen:{speaker}",
                    confidence=confidence,
                )
            )
        return out


# ────────────────────────────────────────────────────────────────────
# 编排器
# ────────────────────────────────────────────────────────────────────


class DiarizationUnavailable(RuntimeError):  # noqa: N818  异常名无 Error 后缀（业务约定）
    """某个 diarizer 无法运行（缺依赖 / 缺 Key）时抛出。"""


class DiarizationService:
    """供转写服务使用的公开入口。

    解析顺序：Qwen → Pyannote → EnergyVAD。每一层先尝试运行，若该层报告
    :class:`DiarizationUnavailable` 则尝试下一层。最后一层始终可用，
    因为它只依赖 ``ffmpeg``。
    """

    PREFERRED_ORDER = ("qwen", "pyannote", "energy-vad")

    def __init__(self) -> None:
        # 按策略 key 注册的 diarizer 字典
        self._diarizers: dict[str, Diarizer] = {}
        self._register_default()

    def _register_default(self) -> None:
        """注册默认策略集合（能量 VAD 始终注册）。"""
        # 总是注册能量 VAD fallback
        self._diarizers["energy-vad"] = EnergyVADDiarizer()
        # 按 key 注册，可选
        try:
            self._diarizers["pyannote"] = PyannoteDiarizer()
        except Exception:  # noqa: BLE001
            logger.debug("pyannote diarizer not registered (dep / token missing)")
        try:
            self._diarizers["qwen"] = QwenDiarizer()
        except Exception:  # noqa: BLE001
            logger.debug("qwen diarizer not registered (key / dep missing)")

    def register(self, key: str, diarizer: Diarizer) -> None:
        """注册/覆盖一个具名 diarizer。"""
        self._diarizers[key] = diarizer

    def available_strategies(self) -> list[str]:
        """返回当前可用策略列表。"""
        return [k for k in self.PREFERRED_ORDER if k in self._diarizers]

    async def diarize(
        self, storage_path: str, language: str | None = None
    ) -> tuple[list[SpeakerTurn], str]:
        """运行说话人分离，返回 (turns, 所用策略)。"""
        last_exc: BaseException | None = None
        for key in self.PREFERRED_ORDER:
            diarizer = self._diarizers.get(key)
            if diarizer is None:
                continue
            try:
                turns = await diarizer.diarize(storage_path, language=language)
                if not turns:
                    continue
                logger.info(
                    "DiarizationService: using %s for %s → %d turns",
                    key, storage_path, len(turns),
                )
                return turns, key
            except DiarizationUnavailable as exc:
                last_exc = exc
                logger.info("DiarizationService: %s unavailable: %s", key, exc)
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                logger.warning("DiarizationService: %s failed: %s", key, exc)

        # 所有策略都失败时用占位标签
        if last_exc is not None:
            logger.warning("DiarizationService: all strategies failed, using single Speaker 1 placeholder")
        return [SpeakerTurn(0.0, 0.0, "Speaker 1", 0.0)], "energy-vad"


# ────────────────────────────────────────────────────────────────────
# 求交辅助
# ────────────────────────────────────────────────────────────────────


def assign_speaker_label(
    start: float,
    end: float,
    turns: Iterable[SpeakerTurn],
) -> str:
    """返回与 ``[start,end]`` 重叠最多的说话人标签。"""
    best: SpeakerTurn | None = None
    best_overlap = 0.0
    for turn in turns:
        overlap = max(0.0, min(end, turn.end) - max(start, turn.start))
        if overlap > best_overlap:
            best_overlap = overlap
            best = turn
    return best.speaker_label if best else "Speaker ?"


async def _run_in_thread(func, *args):
    """把同步代码放到线程中运行的辅助函数（供异步适配器使用）。"""
    import asyncio
    return await asyncio.to_thread(func, *args)