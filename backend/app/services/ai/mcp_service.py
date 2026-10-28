"""MCP 客户端 v1：JSON-RPC over Streamable HTTP / SSE。

安全边界：

- 外部工具返回内容视为**不可信输入**，会加 ``<tool_result>`` 包裹后再交给模型；
- URL 做 SSRF 校验（默认禁止内网地址，可用 ``MCP_ALLOW_PRIVATE_HOSTS`` 显式放开）；
- 凭据复用 ``secret_crypto`` 的 Fernet 加密（``enc::`` 前缀）落库；
- 只有 ``approval_policy='auto'`` 的工具允许在聊天中被模型调用，``ask`` 只能由用户在
  设置页手动执行，``deny`` 一律拒绝；每次调用写审计表。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import re
import socket
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.mcp import McpCallAudit, McpServer, McpServerTool
from app.services.secret_crypto import decrypt_secret, encrypt_secret

logger = logging.getLogger(__name__)

MCP_PROTOCOL_VERSION = "2024-11-05"
TOOL_PREFIX = "mcp__"
_CALL_TIMEOUT = 20.0
MAX_TOOL_DEFINITIONS = 20


class McpError(Exception):
    pass


def _safe_tool_segment(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", value)[:40]


def encode_tool_name(server_id: uuid.UUID | str, tool_name: str) -> str:
    return f"{TOOL_PREFIX}{str(server_id).replace('-', '')[:8]}__{_safe_tool_segment(tool_name)}"


def decode_tool_name(encoded: str) -> tuple[str, str] | None:
    if not encoded.startswith(TOOL_PREFIX) or "__" not in encoded[len(TOOL_PREFIX):]:
        return None
    rest = encoded[len(TOOL_PREFIX):]
    server_short, _, tool_segment = rest.partition("__")
    return server_short, tool_segment


def _is_private_host(hostname: str) -> bool:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        return True
    for info in infos:
        try:
            address = ipaddress.ip_address(info[4][0])
        except ValueError:
            return True
        if (
            address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_reserved
        ):
            return True
    return False


def assert_safe_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise McpError("MCP 服务器地址必须是 http(s) URL")
    if not get_settings().MCP_ALLOW_PRIVATE_HOSTS and _is_private_host(parsed.hostname):
        raise McpError("出于安全考虑，默认禁止连接内网地址；如确需使用请开启 MCP_ALLOW_PRIVATE_HOSTS")
    return url


def _parse_sse_payload(text: str) -> dict[str, Any] | None:
    """从 SSE 响应中取最后一条包含 JSON 的 data 行。"""
    payload: dict[str, Any] | None = None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        candidate = line[len("data:"):].strip()
        if not candidate or candidate == "[DONE]":
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            payload = parsed
    return payload


def _validate_stdio_command(command: str) -> str:
    """stdio 命令白名单：只允许配置中列出的可执行文件（按 basename 前缀）。"""
    if not command or not command.strip():
        raise McpError("stdio 传输必须填写命令")
    base = os.path.basename(command.strip())
    allowed = [
        item.strip()
        for item in get_settings().MCP_STDIO_ALLOWED_COMMANDS.split(",")
        if item.strip()
    ]
    if not any(base == item or base.startswith(item) for item in allowed):
        raise McpError(f"stdio 命令不在白名单内：{base}")
    return command.strip()


async def _stdio_rpc(
    server: McpServer, method: str, params: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """通过 stdio 子进程执行一次 JSON-RPC（每个请求一个进程，避免常驻句柄）。"""
    command = _validate_stdio_command(server.command or "")
    args = [str(item) for item in (server.args or [])]
    process = await asyncio.create_subprocess_exec(
        command,
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )

    async def send(payload: dict[str, Any]) -> None:
        assert process.stdin is not None
        try:
            process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode())
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError) as exc:
            raise McpError("stdio MCP 进程已退出") from exc

    async def wait_for(request_id: str, timeout: float) -> dict[str, Any]:
        assert process.stdout is not None

        async def _read() -> dict[str, Any]:
            while True:
                line = await process.stdout.readline()
                if not line:
                    raise McpError("stdio MCP 进程提前退出")
                text = line.decode("utf-8", errors="ignore").strip()
                if not text:
                    continue
                try:
                    message = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict) and str(message.get("id")) == request_id:
                    return message

        try:
            return await asyncio.wait_for(_read(), timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise McpError("stdio MCP 请求超时") from exc

    try:
        if method != "initialize":
            await send({
                "jsonrpc": "2.0",
                "id": "init",
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "AIDriveNote", "version": "2.0"},
                },
            })
            await wait_for("init", 10.0)
            await send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

        request_id = str(uuid.uuid4())
        await send({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params or {},
        })
        message = await wait_for(request_id, _CALL_TIMEOUT)
        if message.get("error"):
            error = message["error"]
            detail = error.get("message") if isinstance(error, dict) else str(error)
            raise McpError(f"MCP 错误：{detail}")
        result = message.get("result")
        return result if isinstance(result, dict) else {}
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def _rpc(server: McpServer, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    """发送 JSON-RPC 请求；兼容 HTTP(JSON/SSE) 与 stdio 两种传输。"""
    if (server.transport or "http") == "stdio":
        return await _stdio_rpc(server, method, params)
    assert_safe_url(server.url)
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if server.headers_enc:
        try:
            headers.update(json.loads(decrypt_secret(server.headers_enc)))
        except Exception:  # noqa: BLE001
            logger.warning("MCP 服务器凭据解密失败：server=%s", server.id)

    payload = {
        "jsonrpc": "2.0",
        "id": str(uuid.uuid4()),
        "method": method,
        "params": params or {},
    }
    async with httpx.AsyncClient(timeout=_CALL_TIMEOUT) as client:
        response = await client.post(server.url, json=payload, headers=headers)
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            data = _parse_sse_payload(response.text)
        else:
            try:
                data = response.json()
            except json.JSONDecodeError:
                data = _parse_sse_payload(response.text)
    if not isinstance(data, dict):
        raise McpError("MCP 服务器返回了无法解析的响应")
    if data.get("error"):
        error = data["error"]
        message = error.get("message") if isinstance(error, dict) else str(error)
        raise McpError(f"MCP 错误：{message}")
    result = data.get("result")
    return result if isinstance(result, dict) else {}


async def _handshake(server: McpServer) -> None:
    try:
        await _rpc(server, "initialize", {
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "AIDriveNote", "version": "2.0"},
        })
    except Exception:  # noqa: BLE001 — 部分服务器不要求 initialize，继续发现
        logger.debug("MCP initialize 失败，继续尝试 tools/list", exc_info=True)


class McpService:
    @staticmethod
    async def list_servers(db: AsyncSession, user_id: uuid.UUID) -> list[McpServer]:
        result = await db.execute(
            select(McpServer).where(McpServer.user_id == user_id).order_by(McpServer.created_at.desc()),
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_server(
        db: AsyncSession, user_id: uuid.UUID, server_id: uuid.UUID,
    ) -> McpServer | None:
        result = await db.execute(
            select(McpServer).where(McpServer.id == server_id, McpServer.user_id == user_id),
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def create_server(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        name: str,
        url: str = "",
        headers: dict[str, str] | None = None,
        transport: str = "http",
        command: str | None = None,
        args: list[str] | None = None,
    ) -> McpServer:
        transport = transport if transport in {"http", "stdio"} else "http"
        if transport == "stdio":
            _validate_stdio_command(command or "")
        else:
            assert_safe_url(url)
        server = McpServer(
            user_id=user_id,
            name=name.strip()[:100],
            transport=transport,
            url=url.strip(),
            command=(command or "").strip() or None,
            args=args or [],
            headers_enc=encrypt_secret(json.dumps(headers, ensure_ascii=False)) if headers else None,
        )
        db.add(server)
        await db.commit()
        await db.refresh(server)
        return server

    @staticmethod
    async def discover_tools(db: AsyncSession, server: McpServer) -> list[McpServerTool]:
        await _handshake(server)
        result = await _rpc(server, "tools/list", {})
        raw_tools = result.get("tools") if isinstance(result.get("tools"), list) else []
        existing_result = await db.execute(
            select(McpServerTool).where(McpServerTool.server_id == server.id),
        )
        existing = {tool.name: tool for tool in existing_result.scalars().all()}

        tools: list[McpServerTool] = []
        for item in raw_tools:
            if not isinstance(item, dict) or not item.get("name"):
                continue
            name = str(item["name"])[:200]
            schema = item.get("inputSchema")
            tool = existing.get(name)
            if tool is None:
                tool = McpServerTool(
                    server_id=server.id,
                    name=name,
                    description=str(item.get("description") or "")[:2000] or None,
                    input_schema=schema if isinstance(schema, dict) else {},
                    is_enabled=False,
                    approval_policy="ask",
                )
                db.add(tool)
            else:
                tool.description = str(item.get("description") or "")[:2000] or None
                tool.input_schema = schema if isinstance(schema, dict) else {}
            tools.append(tool)
        await db.commit()
        for tool in tools:
            await db.refresh(tool)
        return tools

    @staticmethod
    async def list_tools(db: AsyncSession, server_id: uuid.UUID) -> list[McpServerTool]:
        result = await db.execute(
            select(McpServerTool)
            .where(McpServerTool.server_id == server_id)
            .order_by(McpServerTool.name),
        )
        return list(result.scalars().all())

    @staticmethod
    async def call_tool(
        db: AsyncSession,
        user_id: uuid.UUID,
        server: McpServer,
        tool: McpServerTool,
        arguments: dict[str, Any],
        *,
        enforce_policy: bool = True,
    ) -> dict[str, Any]:
        if enforce_policy:
            if not server.is_enabled or not tool.is_enabled or tool.approval_policy == "deny":
                raise McpError("该工具未启用或已被禁止调用")
            if tool.approval_policy != "auto":
                # 不直接报错：返回结构化待确认结果，前端渲染确认卡后再调用
                return {
                    "success": False,
                    "requires_confirmation": True,
                    "mcpToolId": str(tool.id),
                    "tool": tool.name,
                    "server": server.name,
                    "arguments": arguments,
                    "message": "该 MCP 工具需要你确认后才能执行",
                }

        started = time.monotonic()
        audit = McpCallAudit(
            user_id=user_id,
            server_id=server.id,
            tool_name=tool.name,
            arguments=arguments,
            status="running",
        )
        db.add(audit)
        await db.commit()

        try:
            result = await _rpc(server, "tools/call", {"name": tool.name, "arguments": arguments})
            texts: list[str] = []
            for item in result.get("content") or []:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(str(item.get("text") or ""))
            text = "\n".join(t for t in texts if t).strip()
            audit.status = "ok"
            audit.duration_ms = int((time.monotonic() - started) * 1000)
            await db.commit()
            return {
                "success": True,
                "tool": tool.name,
                "server": server.name,
                # 明确标注来源不可信，降低提示注入风险
                "content": f"<tool_result source=\"mcp:{server.name}\">\n{text}\n</tool_result>",
            }
        except Exception as exc:  # noqa: BLE001
            audit.status = "error"
            audit.error = str(exc)[:2000]
            audit.duration_ms = int((time.monotonic() - started) * 1000)
            await db.commit()
            return {"success": False, "tool": tool.name, "server": server.name, "error": str(exc)}

    @staticmethod
    async def enabled_tool_definitions(
        db: AsyncSession, user_id: uuid.UUID,
    ) -> list[dict[str, Any]]:
        """生成可直接并入 OpenAI tools 的定义（仅 auto 策略、已启用的工具）。"""
        result = await db.execute(
            select(McpServerTool, McpServer)
            .join(McpServer, McpServer.id == McpServerTool.server_id)
            .where(
                McpServer.user_id == user_id,
                McpServer.is_enabled == True,  # noqa: E712
                McpServerTool.is_enabled == True,  # noqa: E712
                McpServerTool.approval_policy == "auto",
            )
            .limit(MAX_TOOL_DEFINITIONS),
        )
        definitions: list[dict[str, Any]] = []
        for tool, server in result.fetchall():
            definitions.append({
                "type": "function",
                "function": {
                    "name": encode_tool_name(server.id, tool.name),
                    "description": f"[MCP:{server.name}] {(tool.description or tool.name)[:500]}",
                    "parameters": tool.input_schema or {"type": "object", "properties": {}},
                },
            })
        return definitions

    @staticmethod
    async def execute_tool(
        db: AsyncSession,
        user_id: uuid.UUID,
        encoded_name: str,
        arguments: dict[str, Any],
    ) -> dict[str, Any]:
        decoded = decode_tool_name(encoded_name)
        if decoded is None:
            return {"success": False, "error": "无效的 MCP 工具名"}
        server_short, tool_segment = decoded
        servers = await McpService.list_servers(db, user_id)
        server = next(
            (s for s in servers if str(s.id).replace("-", "")[:8] == server_short),
            None,
        )
        if server is None:
            return {"success": False, "error": "MCP 服务器不存在或已删除"}
        tools = await McpService.list_tools(db, server.id)
        tool = next((t for t in tools if _safe_tool_segment(t.name) == tool_segment), None)
        if tool is None:
            return {"success": False, "error": "MCP 工具不存在或已移除"}
        try:
            return await McpService.call_tool(db, user_id, server, tool, arguments)
        except McpError as exc:
            return {"success": False, "error": str(exc)}

    @staticmethod
    async def list_audit(
        db: AsyncSession, user_id: uuid.UUID, *, limit: int = 50,
    ) -> list[McpCallAudit]:
        result = await db.execute(
            select(McpCallAudit)
            .where(McpCallAudit.user_id == user_id)
            .order_by(McpCallAudit.created_at.desc())
            .limit(limit),
        )
        return list(result.scalars().all())
