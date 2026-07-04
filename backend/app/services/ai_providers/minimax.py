"""MiniMax provider adapter."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any, AsyncIterator

import httpx

from app.config import get_settings
from app.services.ai_providers.base import AIProviderConfig, BaseAIProvider, ChatMessage, ChatOptions

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.minimax.chat/v1"


def _extract_text(payload: dict[str, Any]) -> str:
    """MiniMax M3 may stream reasoning_content before content."""
    content = payload.get("content")
    if isinstance(content, str) and content:
        return content
    reasoning = payload.get("reasoning_content")
    if isinstance(reasoning, str) and reasoning:
        return reasoning
    return ""


def _extract_message_content(message: dict[str, Any]) -> str:
    content = message.get("content")
    return content if isinstance(content, str) and content else ""


class MiniMaxProvider(BaseAIProvider):
    def _resolve_api_key(self, opts: ChatOptions | None) -> str | None:
        key = (opts.api_key if opts else None) or self.config.api_key
        if not key:
            key = get_settings().MINIMAX_API_KEY
        return (key or "").strip() or None

    @staticmethod
    def _serialize_tool_arguments(args: Any) -> str:
        if isinstance(args, str):
            return args
        return json.dumps(args or {}, ensure_ascii=False)

    def _build_messages(self, messages: list[ChatMessage]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in messages:
            item: dict[str, Any] = {"role": m.role, "content": m.content or ""}
            if m.tool_calls:
                item["tool_calls"] = [
                    {
                        "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                        "type": tc.get("type", "function"),
                        "function": {
                            "name": (tc.get("function") or {}).get("name", ""),
                            "arguments": self._serialize_tool_arguments(
                                (tc.get("function") or {}).get("arguments")
                            ),
                        },
                    }
                    for tc in m.tool_calls
                ]
            out.append(item)
        return out

    @staticmethod
    def _parse_tool_arguments(raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        if not raw:
            return {}
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else {"raw": raw}
            except json.JSONDecodeError:
                return {"raw": raw}
        return {"raw": raw}

    def _emit_tool_call(self, tc: dict[str, Any]) -> dict[str, Any]:
        fn = tc.get("function") or {}
        return {
            "type": "tool_call",
            "tool_call": {
                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "type": tc.get("type", "function"),
                "function": {
                    "name": fn.get("name", ""),
                    "arguments": self._parse_tool_arguments(fn.get("arguments")),
                },
            },
        }

    async def stream_chat_with_tools(
        self,
        messages: list[ChatMessage],
        options: ChatOptions | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        opts = options or ChatOptions()
        base_url = (opts.base_url or self.config.base_url or DEFAULT_BASE_URL).rstrip("/")
        model = opts.model or self.config.model
        api_key = self._resolve_api_key(opts)

        if not api_key:
            yield {
                "type": "content",
                "content": "MiniMax 不可用：缺少 API Key，请在模型配置或环境变量 MINIMAX_API_KEY 中设置",
            }
            return

        if not model:
            yield {"type": "content", "content": "MiniMax 不可用：未配置模型 ID"}
            return

        payload: dict[str, Any] = {
            "model": model,
            "messages": self._build_messages(messages),
            "stream": True,
        }
        temp = opts.temperature if opts.temperature is not None else self.config.temperature
        if temp is not None:
            payload["temperature"] = temp
        if opts.tools:
            payload["tools"] = opts.tools
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        pending_tool_calls: dict[int, dict[str, Any]] = {}
        emitted_tool_ids: set[str] = set()

        def emit_pending() -> list[dict[str, Any]]:
            chunks: list[dict[str, Any]] = []
            for entry in pending_tool_calls.values():
                tc_id = entry.get("id") or ""
                if tc_id in emitted_tool_ids:
                    continue
                if not (entry.get("function") or {}).get("name"):
                    continue
                emitted_tool_ids.add(tc_id)
                chunks.append(self._emit_tool_call(entry))
            pending_tool_calls.clear()
            return chunks

        saw_stream_content = False
        accumulated = ""

        try:
            async with httpx.AsyncClient(timeout=120.0, follow_redirects=True) as client:
                async with client.stream(
                    "POST",
                    f"{base_url}/text/chatcompletion_v2",
                    json=payload,
                    headers=headers,
                ) as resp:
                    resp.raise_for_status()
                    async for line in resp.aiter_lines():
                        if not line.strip():
                            continue
                        if line.startswith("data:"):
                            line = line[5:].strip()
                        if line == "[DONE]":
                            break
                        try:
                            data = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        base_resp = data.get("base_resp") or {}
                        status_code = base_resp.get("status_code", 0)
                        if status_code not in (0, None):
                            msg = base_resp.get("status_msg") or f"错误码 {status_code}"
                            yield {"type": "content", "content": f"MiniMax 错误：{msg}"}
                            return

                        for choice in data.get("choices") or []:
                            delta = choice.get("delta") or {}
                            message = choice.get("message") or {}

                            delta_text = _extract_text(delta)
                            if delta_text:
                                saw_stream_content = True
                                accumulated += delta_text
                                yield {"type": "content", "content": delta_text}
                            else:
                                message_text = _extract_message_content(message)
                                if message_text:
                                    if not saw_stream_content:
                                        saw_stream_content = True
                                        accumulated = message_text
                                        yield {"type": "content", "content": message_text}
                                    elif message_text.startswith(accumulated):
                                        suffix = message_text[len(accumulated):]
                                        if suffix:
                                            accumulated += suffix
                                            yield {"type": "content", "content": suffix}

                            for tc in delta.get("tool_calls") or []:
                                idx = tc.get("index", 0)
                                if idx not in pending_tool_calls:
                                    pending_tool_calls[idx] = {
                                        "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                                        "type": tc.get("type", "function"),
                                        "function": {"name": "", "arguments": ""},
                                    }
                                entry = pending_tool_calls[idx]
                                if tc.get("id"):
                                    entry["id"] = tc["id"]
                                fn = tc.get("function") or {}
                                if fn.get("name"):
                                    entry["function"]["name"] = fn["name"]
                                if fn.get("arguments"):
                                    args = fn["arguments"]
                                    if isinstance(args, str):
                                        entry["function"]["arguments"] += args
                                    else:
                                        entry["function"]["arguments"] = args

                            for tc in message.get("tool_calls") or []:
                                emitted = self._emit_tool_call(tc)
                                tc_id = emitted["tool_call"]["id"]
                                if tc_id in emitted_tool_ids:
                                    continue
                                emitted_tool_ids.add(tc_id)
                                yield emitted

                            if choice.get("finish_reason") == "tool_calls":
                                for chunk in emit_pending():
                                    yield chunk

                    for chunk in emit_pending():
                        yield chunk

        except httpx.HTTPError as exc:
            logger.warning("MiniMax HTTP error (%s): %s", base_url, exc)
            yield {
                "type": "content",
                "content": f"MiniMax 连接失败（{base_url}）：{exc}",
            }
        except Exception as exc:
            logger.warning("MiniMax error: %s", exc)
            yield {"type": "content", "content": f"MiniMax 不可用：{exc}"}
