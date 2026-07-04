"""AI provider abstractions."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, AsyncIterator


@dataclass
class ChatMessage:
    role: str
    content: str
    tool_calls: list[dict[str, Any]] | None = None


@dataclass
class ChatOptions:
    model: str | None = None
    temperature: float | None = None
    tools: list[dict[str, Any]] | None = None
    base_url: str | None = None
    api_key: str | None = None


@dataclass
class AIProviderConfig:
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    temperature: float | None = None


class BaseAIProvider:
    def __init__(self, config: AIProviderConfig):
        self.config = config

    async def stream_chat_with_tools(
        self,
        messages: list[ChatMessage],
        options: ChatOptions | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        raise NotImplementedError

    async def chat_with_tools(
        self,
        messages: list[ChatMessage],
        options: ChatOptions | None = None,
    ) -> dict[str, Any]:
        content_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        async for chunk in self.stream_chat_with_tools(messages, options):
            if chunk.get("type") == "content":
                content_parts.append(chunk.get("content") or "")
            elif chunk.get("type") == "tool_call":
                tool_calls.append(chunk.get("tool_call"))
        return {"content": "".join(content_parts), "tool_calls": tool_calls}
