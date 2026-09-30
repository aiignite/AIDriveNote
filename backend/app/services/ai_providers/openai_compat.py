"""OpenAI-compatible provider adapter (OpenAI / LM Studio)."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncIterator

import httpx

from app.config import get_settings
from app.services.ai_providers.base import AIProviderConfig, BaseAIProvider, ChatMessage, ChatOptions

logger = logging.getLogger(__name__)


class OpenAICompatibleProvider(BaseAIProvider):
    def _resolve_api_key(self, opts: ChatOptions | None) -> str | None:
        key = (opts.api_key if opts else None) or self.config.api_key
        if not key:
            key = get_settings().OPENAI_API_KEY
        return (key or "").strip() or None

    def _convert_content_part(self, part: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(part, dict):
            return None
        part_type = part.get("type")
        if part_type == "text":
            text = part.get("text", "")
            return {"type": "text", "text": text} if text else None
        if part_type == "image":
            mime_type = part.get("mimeType") or part.get("mime_type") or "image/jpeg"
            data = part.get("data") or ""
            if not data:
                return None
            url = data if data.startswith("data:") else f"data:{mime_type};base64,{data}"
            return {"type": "image_url", "image_url": {"url": url}}
        return None

    def _serialize_message_content(self, content: str | list[dict[str, Any]] | None) -> str | list[dict[str, Any]]:
        if isinstance(content, list):
            converted = [
                converted
                for part in content
                if (converted := self._convert_content_part(part)) is not None
            ]
            return converted or ""
        return content or ""

    def _build_messages(self, messages: list[ChatMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in messages:
            item: dict[str, Any] = {"role": m.role, "content": self._serialize_message_content(m.content)}
            if m.role == "tool" and m.tool_call_id:
                item["tool_call_id"] = m.tool_call_id
            if m.tool_calls:
                item["tool_calls"] = [
                    {
                        "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                        "type": tc.get("type", "function"),
                        "function": {
                            "name": (tc.get("function") or {}).get("name", ""),
                            "arguments": json.dumps(
                                (tc.get("function") or {}).get("arguments") or {},
                                ensure_ascii=False,
                            ),
                        },
                    }
                    for tc in m.tool_calls
                ]
            out.append(item)
        return out

    async def stream_chat_with_tools(
        self,
        messages: list[ChatMessage],
        options: ChatOptions | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        opts = options or ChatOptions()
        base_url = (opts.base_url or self.config.base_url or "https://api.openai.com/v1").rstrip("/")
        api_key = self._resolve_api_key(opts)
        if not api_key:
            yield {"type": "content", "content": "OpenAI API Key 未配置"}
            return

        payload: dict[str, Any] = {
            "model": opts.model or self.config.model or "gpt-4o-mini",
            "messages": self._build_messages(messages),
            "stream": True,
        }
        if opts.temperature is not None:
            payload["temperature"] = opts.temperature
        if opts.max_tokens is not None:
            payload["max_tokens"] = opts.max_tokens
        if opts.tools:
            payload["tools"] = [
                {"type": "function", "function": t.get("function", t)}
                for t in opts.tools
            ]

        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST", f"{base_url}/chat/completions", json=payload, headers=headers,
                ) as resp:
                    resp.raise_for_status()
                    tool_calls_acc: dict[int, dict[str, Any]] = {}
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if raw == "[DONE]":
                            break
                        try:
                            data = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        choice = (data.get("choices") or [{}])[0]
                        delta = choice.get("delta") or {}
                        content = delta.get("content")
                        if content:
                            yield {"type": "content", "content": content}
                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            acc = tool_calls_acc.setdefault(idx, {
                                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                                "type": "function",
                                "function": {"name": "", "arguments": ""},
                            })
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                acc["function"]["name"] = fn["name"]
                            if fn.get("arguments"):
                                acc["function"]["arguments"] += fn["arguments"]
                    for tc in tool_calls_acc.values():
                        args_raw = tc["function"]["arguments"]
                        try:
                            args = json.loads(args_raw) if args_raw else {}
                        except json.JSONDecodeError:
                            args = {"raw": args_raw}
                        yield {
                            "type": "tool_call",
                            "tool_call": {
                                "id": tc["id"],
                                "type": "function",
                                "function": {"name": tc["function"]["name"], "arguments": args},
                            },
                        }
        except Exception as exc:
            logger.warning("OpenAI provider error: %s", exc)
            yield {"type": "content", "content": f"OpenAI 请求失败：{exc}"}
