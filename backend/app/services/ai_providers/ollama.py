"""Ollama provider adapter."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncIterator

import httpx

from app.services.ai_providers.base import AIProviderConfig, BaseAIProvider, ChatMessage, ChatOptions

logger = logging.getLogger(__name__)


class OllamaProvider(BaseAIProvider):
    async def stream_chat_with_tools(
        self,
        messages: list[ChatMessage],
        options: ChatOptions | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        opts = options or ChatOptions()
        base_url = (opts.base_url or self.config.base_url or "http://localhost:11434").rstrip("/")
        model = opts.model or self.config.model or "qwen2.5"
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": True,
        }
        if opts.temperature is not None:
            payload["options"] = {"temperature": opts.temperature}
        if opts.tools:
            payload["tools"] = [
                {"type": "function", "function": t.get("function", t)}
                for t in opts.tools
            ]

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream("POST", f"{base_url}/api/chat", json=payload) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        message = data.get("message") or {}
                        for tc in message.get("tool_calls") or []:
                            func = tc.get("function") or {}
                            args = func.get("arguments", {})
                            if isinstance(args, str):
                                try:
                                    args = json.loads(args)
                                except json.JSONDecodeError:
                                    args = {"raw": args}
                            yield {
                                "type": "tool_call",
                                "tool_call": {
                                    "id": f"call_{uuid.uuid4().hex[:8]}",
                                    "type": "function",
                                    "function": {"name": func.get("name", ""), "arguments": args},
                                },
                            }
                        content = message.get("content")
                        if content:
                            yield {"type": "content", "content": content}
        except Exception as exc:
            logger.warning("Ollama error: %s", exc)
            yield {"type": "content", "content": f"Ollama 不可用：{exc}"}
