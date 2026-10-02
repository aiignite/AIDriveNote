"""AIDriveNote ASR Gateway — FastAPI 入口（Windows / Linux GPU 主机）。

本模块提供局域网语音转写网关的 HTTP 接口，供 AIDriveNote 后端在
``NOTE_ASR_MODE=remote`` 时调用。接口契约与网关独立，鉴权走请求头 ``X-API-Key``。

接口：
  GET  /health              健康检查（返回当前模型 / 设备 / 是否忙）
  POST /api/v1/transcribe   转写接口（multipart: file, language?, model_size?）

环境变量（网关自身 ``ASR_*`` 命名，与后端 ``NOTE_ASR_*`` 是两套）：
  ASR_API_KEY       与后端 NOTE_ASR_REMOTE_API_KEY 保持一致（缺失则 fail-closed 拒绝）
  ASR_MODEL         默认模型规格，默认 medium
  ASR_LANGUAGE      默认转写语言，默认 zh
  ASR_DEVICE        推理设备，默认 cuda
  ASR_COMPUTE_TYPE  计算精度，默认 float16
  ASR_PRELOAD       启动时是否预热模型，默认 1
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
import tempfile
import time
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from transcription import TranscribeResult, TranscriptionEngine

logger = logging.getLogger("asr_gateway")

# 网关自身 API Key：优先 ASR_API_KEY，兼容后端 NOTE_ASR_REMOTE_API_KEY 注入
API_KEY = (os.getenv("ASR_API_KEY") or os.getenv("NOTE_ASR_REMOTE_API_KEY") or "").strip()
DEFAULT_MODEL = os.getenv("ASR_MODEL", "medium")
DEFAULT_LANGUAGE = os.getenv("ASR_LANGUAGE", "zh")
DEVICE = os.getenv("ASR_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("ASR_COMPUTE_TYPE", "float16")

app = FastAPI(title="AIDriveNote ASR Gateway", version="1.0.0")
_engine: TranscriptionEngine | None = None
# 串行化 GPU 任务，避免并发请求把 CUDA 卡死 / 无限阻塞。
_transcribe_lock = asyncio.Lock()


class HealthOut(BaseModel):
    """健康检查响应体。"""

    status: str
    model: str
    device: str
    compute_type: str
    busy: bool = False


def _get_engine() -> TranscriptionEngine:
    """惰性获取全局转写引擎单例（首次调用时创建）。"""
    global _engine
    if _engine is None:
        _engine = TranscriptionEngine(
            model_size=DEFAULT_MODEL,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
        )
    return _engine


async def verify_api_key(x_api_key: str | None = Header(None, alias="X-API-Key")) -> None:
    """API Key 校验 — fail-closed：密钥未配置时拒绝服务，防止网关裸奔。"""
    if not API_KEY:
        raise HTTPException(
            status_code=503,
            detail="ASR_API_KEY not configured; refusing unauthenticated access (fail-closed)",
        )
    if not x_api_key or not secrets.compare_digest(x_api_key, API_KEY):
        raise HTTPException(status_code=401, detail="Invalid or missing X-API-Key")


@app.get("/health", response_model=HealthOut)
async def health(_: None = Depends(verify_api_key)) -> HealthOut:
    """健康检查：返回模型规格、设备、精度与是否正在忙。"""
    eng = _get_engine()
    return HealthOut(
        status="ok",
        model=eng.model_size,
        device=eng.device,
        compute_type=eng.compute_type,
        busy=_transcribe_lock.locked(),
    )


@app.post("/api/v1/transcribe", response_model=TranscribeResult)
async def transcribe(
    _: None = Depends(verify_api_key),
    file: UploadFile = File(...),
    language: str | None = Form(None),
    model_size: str | None = Form(None),
) -> TranscribeResult:
    """转写上传的音频文件。

    参数：
        file:        音频文件（webm/opus/wav 等，非 wav 需宿主机安装 ffmpeg）
        language:    转写语言，留空则用 ASR_LANGUAGE / 自动检测
        model_size:  本次覆盖模型规格，留空则用 ASR_MODEL
    """
    suffix = Path(file.filename or "audio.bin").suffix or ".bin"
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty file")

    # 保持临时目录在整个任务期间存活（含线程池中的同步转写工作）。
    tmp = tempfile.TemporaryDirectory(prefix="asr_")
    try:
        path = Path(tmp.name) / f"upload{suffix}"
        path.write_bytes(raw)
        eng = _get_engine()
        lang = language or DEFAULT_LANGUAGE or None
        logger.info(
            "transcribe start name=%s bytes=%d lang=%s model=%s",
            file.filename,
            len(raw),
            lang,
            model_size or DEFAULT_MODEL,
        )
        t0 = time.perf_counter()
        async with _transcribe_lock:
            try:
                # 关键：Whisper/ffmpeg 是同步阻塞调用，必须放到线程里，
                # 否则会卡住 asyncio 事件循环，导致 /health 与后续请求全部挂起。
                result = await asyncio.to_thread(
                    eng.transcribe,
                    path,
                    language=lang,
                    model_size=model_size,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("transcribe failed: %s", exc)
                raise HTTPException(status_code=500, detail=str(exc)[:500]) from exc
        logger.info(
            "transcribe done segments=%d elapsed=%.1fs",
            len(result.segments),
            time.perf_counter() - t0,
        )
        return result
    finally:
        tmp.cleanup()


@app.on_event("startup")
def preload_model() -> None:
    """启动钩子：密钥缺失时告警，并按需预热模型避免首请求冷启动。"""
    # 密钥缺失时高亮告警：所有 API 请求将被 fail-closed 拒绝
    if not API_KEY:
        logger.critical(
            "ASR_API_KEY is NOT set — all API requests will be rejected (fail-closed). "
            "Set ASR_API_KEY (and NOTE_ASR_REMOTE_API_KEY on AIDriveNote side) to enable access."
        )
    # 预热模型，避免首个请求产生数分钟冷启动。
    if os.getenv("ASR_PRELOAD", "1") not in ("0", "false", "False"):
        _get_engine().ensure_loaded()