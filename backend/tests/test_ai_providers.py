"""Tests for AI provider factory and MiniMax adapter."""
from __future__ import annotations

import json

import pytest

from app.services.ai_providers.base import AIProviderConfig, ChatMessage, ChatOptions
from app.services.ai_providers.factory import AIProviderFactory
from app.services.ai_providers.minimax import MiniMaxProvider
from app.services.ai_providers.ollama import OllamaProvider


def test_factory_routes_minimax():
    provider = AIProviderFactory.create(
        "MINIMAX",
        AIProviderConfig(model="MiniMax-M2.5", base_url="https://api.minimax.chat/v1", api_key="test-key"),
    )
    assert isinstance(provider, MiniMaxProvider)


def test_factory_routes_ollama():
    provider = AIProviderFactory.create("OLLAMA", AIProviderConfig(model="qwen2.5"))
    assert isinstance(provider, OllamaProvider)


@pytest.mark.asyncio
async def test_minimax_stream_parses_sse_content(monkeypatch):
    lines = [
        'data: {"choices":[{"delta":{"content":"你好"}}],"base_resp":{"status_code":0}}',
        "data: [DONE]",
    ]

    class FakeResponse:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in lines:
                yield line

    class FakeClient:
        def stream(self, *args, **kwargs):
            return FakeResponse()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr("app.services.ai_providers.minimax.httpx.AsyncClient", lambda **kwargs: FakeClient())

    provider = MiniMaxProvider(
        AIProviderConfig(model="MiniMax-M2.5", base_url="https://api.minimax.chat/v1", api_key="test-key")
    )
    chunks = []
    async for chunk in provider.stream_chat_with_tools(
        [ChatMessage(role="user", content="hi")],
        ChatOptions(model="MiniMax-M2.5", api_key="test-key"),
    ):
        chunks.append(chunk)

    assert chunks == [{"type": "content", "content": "你好"}]


@pytest.mark.asyncio
async def test_minimax_stream_parses_reasoning_content(monkeypatch):
    lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"思考中"}}],"base_resp":{"status_code":0}}',
        'data: {"choices":[{"delta":{"content":"答案"}}],"base_resp":{"status_code":0}}',
        "data: [DONE]",
    ]

    class FakeResponse:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def raise_for_status(self):
            return None

        async def aiter_lines(self):
            for line in lines:
                yield line

    class FakeClient:
        def stream(self, *args, **kwargs):
            return FakeResponse()

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

    monkeypatch.setattr("app.services.ai_providers.minimax.httpx.AsyncClient", lambda **kwargs: FakeClient())

    provider = MiniMaxProvider(
        AIProviderConfig(model="MiniMax-M3", base_url="https://api.minimax.chat/v1", api_key="test-key")
    )
    chunks = []
    async for chunk in provider.stream_chat_with_tools(
        [ChatMessage(role="user", content="hi")],
        ChatOptions(model="MiniMax-M3", api_key="test-key"),
    ):
        chunks.append(chunk)

    assert chunks == [
        {"type": "content", "content": "思考中"},
        {"type": "content", "content": "答案"},
    ]


@pytest.mark.asyncio
async def test_minimax_missing_api_key(monkeypatch):
    monkeypatch.setattr(
        "app.services.ai_providers.minimax.get_settings",
        lambda: type("S", (), {"MINIMAX_API_KEY": None})(),
    )
    provider = MiniMaxProvider(AIProviderConfig(model="MiniMax-M2.5"))
    chunks = []
    async for chunk in provider.stream_chat_with_tools(
        [ChatMessage(role="user", content="hi")],
        ChatOptions(model="MiniMax-M2.5"),
    ):
        chunks.append(chunk)

    assert chunks
    assert "缺少 API Key" in chunks[0]["content"]
