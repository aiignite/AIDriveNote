"""MCP 服务器管理：注册、工具发现、授权策略、手动调用与审计。"""
from __future__ import annotations

import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.exceptions import NotFoundException
from app.models.mcp import McpServer, McpServerTool
from app.models.user import User
from app.services.ai.mcp_service import McpError, McpService

router = APIRouter(prefix="/mcp", tags=["MCP"])


class McpServerCreate(BaseModel):
    name: str
    url: str = ""
    headers: Optional[dict[str, str]] = None
    transport: Literal["http", "stdio"] = "http"
    command: Optional[str] = None
    args: Optional[list[str]] = None


class McpServerUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    headers: Optional[dict[str, str]] = None
    isEnabled: Optional[bool] = None
    command: Optional[str] = None
    args: Optional[list[str]] = None


class McpToolUpdate(BaseModel):
    isEnabled: Optional[bool] = None
    approvalPolicy: Optional[Literal["auto", "ask", "deny"]] = None


class McpToolCall(BaseModel):
    arguments: dict[str, Any] = {}


class McpToolOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    inputSchema: dict[str, Any] = {}
    isEnabled: bool
    approvalPolicy: str


class McpServerOut(BaseModel):
    id: str
    name: str
    url: str
    transport: str
    command: Optional[str] = None
    args: list[str] = []
    isEnabled: bool
    tools: list[McpToolOut] = []


class McpAuditOut(BaseModel):
    id: str
    serverId: str
    toolName: str
    status: str
    error: Optional[str] = None
    durationMs: int
    createdAt: Optional[str] = None


def _tool_out(tool: McpServerTool) -> McpToolOut:
    return McpToolOut(
        id=str(tool.id),
        name=tool.name,
        description=tool.description,
        inputSchema=tool.input_schema or {},
        isEnabled=tool.is_enabled,
        approvalPolicy=tool.approval_policy,
    )


async def _server_out(db: AsyncSession, server: McpServer) -> McpServerOut:
    tools = await McpService.list_tools(db, server.id)
    return McpServerOut(
        id=str(server.id),
        name=server.name,
        url=server.url,
        transport=server.transport,
        command=server.command,
        args=list(server.args or []),
        isEnabled=server.is_enabled,
        tools=[_tool_out(tool) for tool in tools],
    )


@router.get("/servers", response_model=list[McpServerOut])
async def list_servers(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    servers = await McpService.list_servers(db, user.id)
    return [await _server_out(db, server) for server in servers]


@router.post("/servers", response_model=McpServerOut)
async def create_server(
    body: McpServerCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        server = await McpService.create_server(
            db,
            user.id,
            name=body.name,
            url=body.url,
            headers=body.headers,
            transport=body.transport,
            command=body.command,
            args=body.args,
        )
    except McpError as exc:
        from app.exceptions import BadRequestException

        raise BadRequestException(str(exc)) from exc
    return await _server_out(db, server)


@router.patch("/servers/{server_id}", response_model=McpServerOut)
async def update_server(
    server_id: uuid.UUID,
    body: McpServerUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    server = await McpService.get_server(db, user.id, server_id)
    if server is None:
        raise NotFoundException("MCP server")
    if body.name is not None:
        server.name = body.name.strip()[:100]
    if body.url is not None:
        from app.services.ai.mcp_service import assert_safe_url

        try:
            if server.transport != "stdio":
                assert_safe_url(body.url)
        except McpError as exc:
            from app.exceptions import BadRequestException

            raise BadRequestException(str(exc)) from exc
        server.url = body.url.strip()
    if body.command is not None:
        from app.services.ai.mcp_service import _validate_stdio_command

        try:
            _validate_stdio_command(body.command)
        except McpError as exc:
            from app.exceptions import BadRequestException

            raise BadRequestException(str(exc)) from exc
        server.command = body.command.strip() or None
    if body.args is not None:
        server.args = [str(item) for item in body.args]
    if body.headers is not None:
        import json

        from app.services.secret_crypto import encrypt_secret

        server.headers_enc = encrypt_secret(json.dumps(body.headers, ensure_ascii=False))
    if body.isEnabled is not None:
        server.is_enabled = body.isEnabled
    await db.commit()
    await db.refresh(server)
    return await _server_out(db, server)


@router.delete("/servers/{server_id}")
async def delete_server(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    server = await McpService.get_server(db, user.id, server_id)
    if server is None:
        raise NotFoundException("MCP server")
    await db.delete(server)
    await db.commit()
    return {"success": True}


@router.post("/servers/{server_id}/discover", response_model=list[McpToolOut])
async def discover_tools(
    server_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    server = await McpService.get_server(db, user.id, server_id)
    if server is None:
        raise NotFoundException("MCP server")
    try:
        tools = await McpService.discover_tools(db, server)
    except McpError as exc:
        from app.exceptions import BadRequestException

        raise BadRequestException(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — 网络错误统一转 400
        from app.exceptions import BadRequestException

        raise BadRequestException(f"连接 MCP 服务器失败：{exc}") from exc
    return [_tool_out(tool) for tool in tools]


async def _get_tool_with_owner(
    db: AsyncSession, user_id: uuid.UUID, tool_id: uuid.UUID,
) -> tuple[McpServerTool, McpServer]:
    result = await db.execute(
        select(McpServerTool, McpServer)
        .join(McpServer, McpServer.id == McpServerTool.server_id)
        .where(McpServerTool.id == tool_id, McpServer.user_id == user_id),
    )
    row = result.first()
    if row is None:
        raise NotFoundException("MCP tool")
    return row[0], row[1]


@router.patch("/tools/{tool_id}", response_model=McpToolOut)
async def update_tool(
    tool_id: uuid.UUID,
    body: McpToolUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    tool, _server = await _get_tool_with_owner(db, user.id, tool_id)
    if body.isEnabled is not None:
        tool.is_enabled = body.isEnabled
    if body.approvalPolicy is not None:
        tool.approval_policy = body.approvalPolicy
    await db.commit()
    await db.refresh(tool)
    return _tool_out(tool)


@router.post("/tools/{tool_id}/call")
async def call_tool(
    tool_id: uuid.UUID,
    body: McpToolCall,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """设置页手动执行：不受 approval_policy 的 auto 限制（仍需工具已启用）。"""
    tool, server = await _get_tool_with_owner(db, user.id, tool_id)
    try:
        return await McpService.call_tool(
            db, user.id, server, tool, body.arguments, enforce_policy=False,
        )
    except McpError as exc:
        from app.exceptions import BadRequestException

        raise BadRequestException(str(exc)) from exc


@router.get("/audit", response_model=list[McpAuditOut])
async def list_audit(
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = await McpService.list_audit(db, user.id, limit=limit)
    return [
        McpAuditOut(
            id=str(row.id),
            serverId=str(row.server_id),
            toolName=row.tool_name,
            status=row.status,
            error=row.error,
            durationMs=row.duration_ms,
            createdAt=row.created_at.isoformat() if row.created_at else None,
        )
        for row in rows
    ]
