"""局域网 GPU ASR 网关 HTTP 客户端（NOTE_ASR_MODE=remote）。

将整段录音以 multipart/form-data 上传，并把网关返回的 JSON 映射为
转写服务的分段字典列表。契约与 asr_gateway 的 ``POST /api/v1/transcribe``
保持一致，鉴权沿用 ``X-API-Key`` 请求头。
"""
from __future__ import annotations

import logging
import mimetypes
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class NoteAsrRemoteError(RuntimeError):
    """远程 ASR 网关调用失败。"""


class NoteAsrRemoteClient:
    """围绕 ``POST /api/v1/transcribe`` 的轻量 httpx 封装。"""

    def __init__(
        self,
        *,
        url: str,
        api_key: str = "",
        timeout_seconds: int = 3600,
    ) -> None:
        """初始化客户端。

        属性说明：
            url: 远程转写端点，例如 ``http://host:8090/api/v1/transcribe``。
            api_key: 与 asr_gateway 共享的 X-API-Key，空串则不携带鉴权头。
            timeout_seconds: 读取超时（秒），长录音需调大。
        """
        self._url = (url or "").strip()
        if not self._url:
            raise NoteAsrRemoteError("NOTE_ASR_REMOTE_URL is empty")
        self._api_key = (api_key or "").strip()
        self._timeout = max(30, int(timeout_seconds or 3600))

    @property
    def health_url(self) -> str:
        """尽可能从转写 URL 推导出 ``.../health`` 健康检查地址。"""
        base = self._url.rstrip("/")
        if base.endswith("/api/v1/transcribe"):
            return base[: -len("/api/v1/transcribe")] + "/health"
        if base.endswith("/transcribe"):
            return base[: -len("/transcribe")] + "/health"
        # 兜底：同主机、路径 /health
        from urllib.parse import urlparse, urlunparse

        parsed = urlparse(self._url)
        return urlunparse((parsed.scheme, parsed.netloc, "/health", "", "", ""))

    async def health_check(self) -> bool:
        """网关 ``/health`` 返回 2xx 时返回 True。"""
        ok, _ = await self.health_check_detail()
        return ok

    async def health_check_detail(self) -> tuple[bool, str]:
        """探测 ``/health`` 并返回 ``(ok, 人类可读详情)``。"""
        url = self.health_url
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url, headers=self._headers())
            if 200 <= resp.status_code < 300:
                return True, f"remote ASR gateway responded ({resp.status_code}) at {url}"
            if resp.status_code in (401, 403):
                return False, (
                    f"remote ASR auth failed ({resp.status_code}) at {url}; "
                    "请确认页面 API Key 与 Windows ASR_API_KEY / .env.prod 中 NOTE_ASR_REMOTE_API_KEY 一致后重新保存"
                )
            body = (resp.text or "")[:120]
            return False, f"remote ASR health check failed HTTP {resp.status_code} at {url}: {body}"
        except httpx.TimeoutException:
            return False, f"remote ASR health check timeout (5s) connecting to {url}"
        except httpx.HTTPError as exc:
            return False, f"remote ASR connection error to {url}: {exc}"
        except Exception as exc:  # noqa: BLE001
            logger.debug("ASR remote health check failed: %s", exc)
            return False, f"remote ASR health check failed: {exc}"

    async def transcribe_file(
        self,
        file_path: Path,
        *,
        language: str | None = None,
        model_size: str | None = None,
    ) -> list[dict[str, Any]]:
        """上传 ``file_path`` 并返回原始分段字典列表。

        每个字典形如 ``{start, end, text, confidence?, language?}``。
        """
        if not file_path.exists():  # noqa: ASYNC240  async 中 os.path 调用（框架限制）
            raise NoteAsrRemoteError(f"recording file not found: {file_path}")

        mime, _ = mimetypes.guess_type(str(file_path))
        mime = mime or "application/octet-stream"
        data: dict[str, str] = {}
        if language:
            data["language"] = language
        if model_size:
            data["model_size"] = model_size

        size_mb = file_path.stat().st_size / (1024 * 1024)  # noqa: ASYNC240  async 中 os.path 调用（框架限制）
        logger.info(
            "POST remote ASR %s (%.2f MB, timeout=%ss)",
            self._url,
            size_mb,
            self._timeout,
        )
        # 连接与读取超时分离：连接失败快速失败；GPU 推理使用读取超时。
        timeout = httpx.Timeout(
            connect=30.0,
            read=float(self._timeout),
            write=120.0,
            pool=30.0,
        )
        try:
            # 中小录音直接读入内存，让 multipart 请求体完全由 httpx 持有
            # （规避阻塞式文件 IO 的边界问题）。
            payload = file_path.read_bytes()  # noqa: ASYNC240  async 中 os.path 调用（框架限制）
            async with httpx.AsyncClient(timeout=timeout) as client:
                files = {"file": (file_path.name, payload, mime)}
                resp = await client.post(
                    self._url,
                    headers=self._headers(),
                    data=data,
                    files=files,
                )
        except httpx.TimeoutException as exc:
            raise NoteAsrRemoteError(
                f"remote ASR timeout after {self._timeout}s: {self._url}"
            ) from exc
        except httpx.HTTPError as exc:
            raise NoteAsrRemoteError(f"remote ASR connection error: {exc}") from exc
        logger.info(
            "remote ASR HTTP %s in response (%d bytes body)",
            resp.status_code,
            len(resp.content or b""),
        )

        if resp.status_code in (401, 403):
            raise NoteAsrRemoteError(
                f"remote ASR auth failed ({resp.status_code}); check NOTE_ASR_REMOTE_API_KEY"
            )
        if resp.status_code >= 400:
            body = (resp.text or "")[:300]
            raise NoteAsrRemoteError(
                f"remote ASR HTTP {resp.status_code}: {body}"
            )

        try:
            payload = resp.json()
        except Exception as exc:  # noqa: BLE001
            raise NoteAsrRemoteError("remote ASR returned non-JSON body") from exc

        return self._parse_segments(payload)

    def _headers(self) -> dict[str, str]:
        """构造远程请求头；未配置 Key 时返回空。"""
        if not self._api_key:
            return {}
        return {"X-API-Key": self._api_key}

    @staticmethod
    def _parse_segments(payload: Any) -> list[dict[str, Any]]:
        """把网关返回体归一化为分段字典列表。"""
        if isinstance(payload, list):
            raw_list = payload
        elif isinstance(payload, dict):
            raw_list = payload.get("segments") or payload.get("result") or []
        else:
            raise NoteAsrRemoteError("remote ASR response shape unsupported")

        if not isinstance(raw_list, list):
            raise NoteAsrRemoteError("remote ASR segments is not a list")

        out: list[dict[str, Any]] = []
        for item in raw_list:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            try:
                start = float(item.get("start") or 0)
                end = float(item.get("end") or start)
            except (TypeError, ValueError):
                continue
            conf = item.get("confidence")
            try:
                confidence = float(conf) if conf is not None else None
            except (TypeError, ValueError):
                confidence = None
            out.append(
                {
                    "start": start,
                    "end": end,
                    "text": text,
                    "confidence": confidence,
                    "language": item.get("language"),
                }
            )
        return out