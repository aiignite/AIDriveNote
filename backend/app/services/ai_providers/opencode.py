"""OpenCode Zen 免费匿名通道 provider。

参照 DSH 插件 ``@opencode2dsh/dsh-plugin``（0.3.7，adapter 模式）的实现直连
OpenCode Zen 的匿名免费通道（https://opencode.ai/zen/v1）：

- 鉴权就是字面量 ``Bearer public``，不需要任何真实 API Key；
- 请求与 OpenCode CLI 的流量同形：CLI 相同的 User-Agent + 完整伪装头组
  （``x-opencode-client / x-opencode-session / x-session-affinity /
  X-Session-Id / x-opencode-request / x-opencode-project``）；
- **会话 id 必须是 Zen 免费通道的规范形状** ``ses_<12hex><14base62>``——
  2026-09-16 起上游用 403 FreeTierError 拒绝其他形状（UA 门禁已不够）；
  其他身份信号经 SHA-256 确定性地哈希进规范形状，同一会话保持稳定；
- **请求体必须满足 free-lane agent 形状门禁**：流式调用且 tools 里包含
  ``bash`` / ``read`` 两个保留占位工具（缺失时自动补齐；上下文本身没有
  工具时附 ``tool_choice: "none"``，保证模型不会调用注入的占位工具）；
- 模型仅限上游目录中的免费模型（id 含 ``free`` 及已验证的例外）。

注意：匿名通道按 IP 限流，服务端部署时所有用户共享同一出口 IP 的额度，
定位是免费公共 / 备用模型，不适合作为高并发主力渠道；Zen 也可能继续
收紧校验，不能当生产依赖。
"""
from __future__ import annotations

import hashlib
import platform
import re
import uuid
from typing import Any

from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.openai_compat import OpenAICompatibleProvider

# 与 OpenCode CLI 一致的 User-Agent（ids.go opencodeUserAgent）
OPENCODE_USER_AGENT = f"opencode/1.18.31 ({platform.system().lower()} {platform.machine()}; node22)"
# 匿名通道的固定 Key（字面量 public）
OPENCODE_PUBLIC_KEY = "public"
DEFAULT_ZEN_BASE_URL = "https://opencode.ai/zen/v1"

CANONICAL_SESSION_RE = re.compile(r"^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$")
_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
# free-lane agent 形状门禁要求的保留工具名（messages.ts ensureFreeLaneShape）
FREE_LANE_GATE_TOOL_NAMES = ["bash", "read"]


def canonical_session_id(signal: str) -> str:
    """把任意会话信号确定性映射为 Zen 免费通道认可的规范会话 id。

    规范形状：``ses_`` + 12 位小写十六进制（时间戳位）+ 14 位 Base62。
    """
    if CANONICAL_SESSION_RE.match(signal or ""):
        return signal
    digest = hashlib.sha256(b"ses\x00" + (signal or "").encode("utf-8")).digest()
    ts_hex = digest[:6].hex()
    n = int.from_bytes(digest[6:16], "big")
    chars: list[str] = []
    for _ in range(14):
        chars.append(_BASE62[n % 62])
        n //= 62
    return f"ses_{ts_hex}{''.join(chars)}"


def _derive_session_signal(messages: list[ChatMessage], options: ChatOptions | None) -> str:
    """从会话首条用户消息派生稳定信号（同一会话稳定、不可逆推）。"""
    seed = (options.model if options else None) or ""
    for m in messages:
        if m.role == "user":
            content = m.content
            if isinstance(content, list):
                content = "".join(
                    part.get("text", "") for part in content if isinstance(part, dict)
                )
            seed += "|" + (content or "")
            break
    return seed or uuid.uuid4().hex


def ensure_free_lane_shape(payload: dict[str, Any]) -> dict[str, Any]:
    """补齐 free-lane agent 形状门禁要求的 ``bash``/``read`` 保留工具。

    仅追加缺失的占位工具；上下文本身没有任何工具时附 ``tool_choice: "none"``，
    确保模型不会真正调用注入的占位工具；调用方已有的工具与 tool_choice 原样保留。
    """
    tools = payload.get("tools") if isinstance(payload.get("tools"), list) else []
    names = {
        (t.get("function") or {}).get("name")
        for t in tools
        if isinstance(t, dict) and isinstance(t.get("function"), dict)
    }
    missing = [n for n in FREE_LANE_GATE_TOOL_NAMES if n not in names]
    if not missing:
        return payload
    out = dict(payload)
    out["tools"] = list(tools) + [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": "Reserved for the host runtime; do not call it.",
                "parameters": {"type": "object", "properties": {}},
            },
        }
        for name in missing
    ]
    if not tools:
        out["tool_choice"] = "none"
    return out


class OpenCodeProvider(OpenAICompatibleProvider):
    """OpenAI-compatible adapter for the OpenCode Zen anonymous free channel."""

    def _resolve_api_key(self, opts: ChatOptions | None) -> str | None:
        # 匿名通道不需要真实 Key；模型配置里填了就尊重（如未来换官方 Key）
        key = (opts.api_key if opts else None) or self.config.api_key
        return (key or "").strip() or OPENCODE_PUBLIC_KEY

    def _retry_on_429(self, attempt: int) -> bool:
        # 匿名通道按 IP 限流；与插件一致做静默退避重试（最多 3 次）
        return attempt < 3

    def _build_headers(self, api_key: str) -> dict[str, str]:
        # 会话 id 由 stream_chat_with_tools 派生后暂存
        session_id = getattr(self, "_last_session_id", "")
        project_id = getattr(self, "_last_project_id", "")
        return {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": OPENCODE_USER_AGENT,
            "x-opencode-client": "cli",
            "x-opencode-session": session_id,
            "x-session-affinity": session_id,
            "X-Session-Id": session_id,
            "x-opencode-request": uuid.uuid4().hex,
            "x-opencode-project": project_id,
        }

    async def stream_chat_with_tools(
        self,
        messages: list[ChatMessage],
        options: ChatOptions | None = None,
    ) -> Any:
        session_id = canonical_session_id(_derive_session_signal(messages, options))
        self._last_session_id = session_id
        self._last_project_id = canonical_session_id(session_id + "-project")
        # 匿名通道默认 base_url 指向 Zen
        opts = options or ChatOptions()
        if not (opts.base_url or self.config.base_url):
            opts.base_url = DEFAULT_ZEN_BASE_URL
        async for chunk in super().stream_chat_with_tools(messages, opts):
            yield chunk

    def _prepare_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        """基类发送前的 payload 钩子：补齐 free-lane 工具门禁。"""
        return ensure_free_lane_shape(payload)


def get_opencode_free_models() -> list[str]:
    """静态已验证的免费模型名单（匿名通道实测）。"""
    return [
        "big-pickle",
        "ling-3.1-flash-free",
        "mimo-v2.6-flash-free",
        "muse-spark-1.2-contributor-free",
        "muse-spark-1.3-contributor-free",
        "nemotron-3.5-lightning-free",
        "jev-1.13-free",
        "step-5-preview-free",
        "longcat-2.5-preview-free",
        "space-bunny-free",
    ]


def is_free_model(model_id: str) -> bool:
    return "free" in (model_id or "").lower()


async def fetch_zen_free_models(base_url: str | None = None) -> list[str]:
    """实时拉取 Zen 目录并过滤出免费模型；失败时返回静态名单。"""
    import httpx

    url = (base_url or DEFAULT_ZEN_BASE_URL).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{url}/models",
                headers={
                    "Authorization": f"Bearer {OPENCODE_PUBLIC_KEY}",
                    "User-Agent": OPENCODE_USER_AGENT,
                    "x-opencode-client": "cli",
                    "accept": "application/json",
                },
            )
            resp.raise_for_status()
            data = resp.json().get("data") or []
            live = [m.get("id") for m in data if m.get("id")]
            free = [m for m in live if is_free_model(m)]
            # 少数免费模型名里没有 free（如 big-pickle），与静态名单交集兜底
            free += [m for m in get_opencode_free_models() if m in live and m not in free]
            return free or get_opencode_free_models()
    except Exception:
        return get_opencode_free_models()
