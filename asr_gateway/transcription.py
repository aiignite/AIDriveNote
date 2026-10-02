"""asr_gateway 的 Whisper 转写引擎（GPU / CPU）。

基于 faster-whisper 实现音频转写：优先 CUDA，不可用时自动回退 ``cpu/int8``。
非 wav 音频依赖宿主机 ffmpeg 转成 16k 单声道 wav 后再送入模型。
"""
from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class SegmentOut(BaseModel):
    """单个转写片段。"""

    start: float
    end: float
    text: str
    confidence: float | None = None
    language: str | None = None


class TranscribeResult(BaseModel):
    """转写结果（与后端接口契约保持一致：segments 列表）。"""

    segments: list[SegmentOut] = Field(default_factory=list)


class TranscriptionEngine:
    """Whisper 转写引擎：按模型规格缓存已加载模型并执行转写。"""

    def __init__(
        self,
        *,
        model_size: str = "medium",
        device: str = "cuda",
        compute_type: str = "float16",
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        # 已加载模型缓存：model_size -> WhisperModel
        self._models: dict[str, object] = {}

    def ensure_loaded(self, model_size: str | None = None) -> None:
        """预热：确保指定规格（默认实例规格）的模型已加载。"""
        size = model_size or self.model_size
        self._get_model(size)

    def _get_model(self, model_size: str):
        """按规格获取模型，未加载则加载；优先 CUDA，失败回退 cpu/int8。"""
        if model_size not in self._models:
            from faster_whisper import WhisperModel

            # 优先 CUDA；GPU 不可用时回退 CPU int8
            device = self.device
            compute = self.compute_type
            try:
                self._models[model_size] = WhisperModel(
                    model_size, device=device, compute_type=compute
                )
            except Exception as exc:  # noqa: BLE001
                if device != "cpu":
                    logger.warning(
                        "CUDA load failed (%s); falling back to cpu/int8", exc
                    )
                    device = "cpu"
                    compute = "int8"
                    self.device = device
                    self.compute_type = compute
                    self._models[model_size] = WhisperModel(
                        model_size, device=device, compute_type=compute
                    )
                else:
                    raise
            logger.info(
                "WhisperModel loaded: %s device=%s compute=%s",
                model_size,
                device,
                compute,
            )
        return self._models[model_size]

    def transcribe(
        self,
        path: Path,
        *,
        language: str | None = "zh",
        model_size: str | None = None,
    ) -> TranscribeResult:
        """转写单个音频文件并返回分段结果。

        参数：
            path:        音频文件路径
            language:    转写语言；None 表示自动检测
            model_size:  本次使用的模型规格；None 表示用实例默认
        """
        size = model_size or self.model_size
        model = self._get_model(size)

        # 优先 16k 单声道 wav。无 ffmpeg 时非 wav（webm/opus）常会卡住或失败。
        work = path
        tmp_wav: Path | None = None
        if path.suffix.lower() not in {".wav"}:
            if not shutil.which("ffmpeg"):
                raise RuntimeError(
                    f"ffmpeg not found; cannot decode {path.suffix}. "
                    "Install ffmpeg on this host, or upload WAV from AIDriveNote."
                )
            tmp_wav = path.with_suffix(".16k.wav")
            try:
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-i",
                        str(path),
                        "-ar",
                        "16000",
                        "-ac",
                        "1",
                        str(tmp_wav),
                    ],
                    check=True,
                    capture_output=True,
                    timeout=600,
                )
                work = tmp_wav
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"ffmpeg convert failed: {exc}") from exc

        segments_iter, info = model.transcribe(  # type: ignore[union-attr]
            str(work),
            language=language or None,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        lang = getattr(info, "language", language)
        out: list[SegmentOut] = []
        for seg in segments_iter:
            text = (seg.text or "").strip()
            if not text:
                continue
            conf = None
            if hasattr(seg, "avg_logprob") and seg.avg_logprob is not None:
                # 将 logprob（约 -1..0）映射为 0..1 的软置信度
                conf = max(0.0, min(1.0, 1.0 + float(seg.avg_logprob)))
            out.append(
                SegmentOut(
                    start=float(seg.start),
                    end=float(seg.end),
                    text=text,
                    confidence=conf,
                    language=lang,
                )
            )
        if tmp_wav and tmp_wav.exists():
            try:
                tmp_wav.unlink()
            except OSError:
                pass
        return TranscribeResult(segments=out)