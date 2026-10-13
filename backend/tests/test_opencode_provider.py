"""OpenCode Zen 免费公共通道 provider 测试。"""
from __future__ import annotations

import re

from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.factory import AIProviderFactory
from app.services.ai_providers.opencode import (
    DEFAULT_ZEN_BASE_URL,
    OPENCODE_PUBLIC_KEY,
    OpenCodeProvider,
    canonical_session_id,
    ensure_free_lane_shape,
)

CANONICAL = re.compile(r"^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$")


def test_canonical_session_id_shape():
    """任意信号都应映射为 Zen 认可的规范形状，且同一信号保持稳定。"""
    a = canonical_session_id("conv-123|你好")
    b = canonical_session_id("conv-123|你好")
    c = canonical_session_id("conv-456|再见")
    assert CANONICAL.match(a)
    assert a == b
    assert a != c


def test_canonical_session_id_passthrough():
    """已是规范形状的官方会话 id 原样透传。"""
    official = "ses_abcdef012345ABCDEFGHIJKLMN"
    assert canonical_session_id(official) == official


def test_factory_creates_opencode_provider():
    provider = AIProviderFactory.create(
        "OPENCODE", AIProviderConfig(base_url=DEFAULT_ZEN_BASE_URL)
    )
    assert isinstance(provider, OpenCodeProvider)


def test_resolve_api_key_defaults_to_public():
    """未配置 Key 时使用匿名通道字面量 public。"""
    provider = OpenCodeProvider(AIProviderConfig())
    assert provider._resolve_api_key(None) == OPENCODE_PUBLIC_KEY
    assert provider._resolve_api_key(ChatOptions(api_key="sk-real")) == "sk-real"


def test_free_lane_shape_injects_gate_tools():
    """无工具的请求体会被补上 bash/read 占位工具并附 tool_choice=none。"""
    payload = {"model": "x", "stream": True, "messages": [{"role": "user", "content": "hi"}]}
    shaped = ensure_free_lane_shape(payload)
    names = [t["function"]["name"] for t in shaped["tools"]]
    assert "bash" in names and "read" in names
    assert shaped["tool_choice"] == "none"
    # 原有消息不被破坏
    assert shaped["messages"] == payload["messages"]


def test_free_lane_shape_keeps_existing_tools():
    """已有工具时补齐缺失的占位工具，但保留调用方的 tool_choice。"""
    tools = [{"type": "function", "function": {"name": "get_note", "parameters": {}}}]
    payload = {"messages": [], "tools": tools, "tool_choice": "auto"}
    shaped = ensure_free_lane_shape(payload)
    names = [t["function"]["name"] for t in shaped["tools"]]
    assert names == ["get_note", "bash", "read"]
    assert shaped["tool_choice"] == "auto"


def test_stream_session_headers_are_canonical():
    """每次流式调用派生规范会话 id 并写入伪装头。"""
    provider = OpenCodeProvider(AIProviderConfig(base_url=DEFAULT_ZEN_BASE_URL))
    provider._last_session_id = canonical_session_id("s1")
    provider._last_project_id = canonical_session_id("s1-project")
    headers = provider._build_headers(OPENCODE_PUBLIC_KEY)
    assert headers["Authorization"] == f"Bearer {OPENCODE_PUBLIC_KEY}"
    assert headers["x-opencode-client"] == "cli"
    assert CANONICAL.match(headers["x-opencode-session"])
    assert headers["x-session-affinity"] == headers["x-opencode-session"]
    assert headers["X-Session-Id"] == headers["x-opencode-session"]
    assert headers["x-opencode-request"]
    assert headers["User-Agent"].startswith("opencode/")


def test_retry_policy():
    provider = OpenCodeProvider(AIProviderConfig())
    assert provider._retry_on_429(0) and provider._retry_on_429(2)
    assert not provider._retry_on_429(3)
