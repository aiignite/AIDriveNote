"""asr_gateway 的 Whisper 转写引擎（GPU / CPU）。

基于 faster-whisper 实现音频转写：优先 CUDA，不可用时自动回退 ``cpu/int8``。
音频统一经 ffmpeg 解码为 16k 单声道 float32 数组后再送入模型——详见
:meth:`TranscriptionEngine._decode_to_array` 中对 PyAV 兼容性的说明。
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import wave
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

    def _decode_to_array(self, path: Path):
        """把任意音频解码为 16k 单声道 float32 数组。

        为什么不用 faster-whisper 自带的解码：其内部走 ``av.open(..., metadata_errors="ignore")``，
        而该参数在 PyAV 19 中已被移除，直接传文件会抛
        ``TypeError: open() got an unexpected keyword argument 'metadata_errors'``。
        这里改为用 ffmpeg CLI 统一转 16k 单声道 PCM wav，再用标准库 ``wave`` 读取为
        numpy 数组，从而完全绕开 PyAV 的解码路径（模型对数组输入同样支持）。

        @param path 待解码的音频文件路径
        @returns float32 的一维波形数组，取值范围 [-1, 1]
        """
        import numpy as np

        if not shutil.which("ffmpeg"):
            raise RuntimeError(
                f"ffmpeg not found; cannot decode {path.suffix}. Install ffmpeg on this host."
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
                    "-c:a",
                    "pcm_s16le",
                    str(tmp_wav),
                ],
                check=True,
                capture_output=True,
                timeout=600,
            )
            with wave.open(str(tmp_wav), "rb") as w:
                frames = w.readframes(w.getnframes())
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"ffmpeg decode failed: {exc}") from exc
        finally:
            if tmp_wav.exists():
                try:
                    tmp_wav.unlink()
                except OSError:
                    pass

        return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0

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

        # 先解码成波形数组，再交给模型（见 _decode_to_array 的兼容性说明）
        audio = self._decode_to_array(path)

        segments_iter, info = model.transcribe(  # type: ignore[union-attr]
            audio,
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
        return TranscribeResult(segments=out)