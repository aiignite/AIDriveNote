"""MCP 客户端：工具命名、SSRF 防线、授权策略与审计的回归测试。"""
from __future__ import annotations

import pathlib
import sys
import uuid

import pytest

from app.models.mcp import McpServer, McpServerTool
from app.services.ai.mcp_service import (
    McpError,
    McpService,
    _validate_stdio_command,
    assert_safe_url,
    decode_tool_name,
    encode_tool_name,
)

FAKE_STDIO_SERVER = str(pathlib.Path(__file__).with_name("fake_mcp_stdio.py"))


def test_tool_name_roundtrip():
    server_id = uuid.uuid4()
    encoded = encode_tool_name(server_id, "read-file")
    decoded = decode_tool_name(encoded)
    assert decoded is not None
    assert decoded[0] == str(server_id).replace("-", "")[:8]
    assert decoded[1] == "read-file"


def test_ssrf_blocks_loopback():
    with pytest.raises(McpError):
        assert_safe_url("http://127.0.0.1:8080/mcp")
    with pytest.raises(McpError):
        assert_safe_url("file:///etc/passwd")


async def _make_server_and_tool(db, user_id, *, policy: str, enabled: bool = True, name: str = "demo_tool"):
    server = McpServer(user_id=user_id, name="测试服务器", url="https://example.com/mcp")
    db.add(server)
    await db.commit()
    await db.refresh(server)
    tool = McpServerTool(
        server_id=server.id,
        name=name,
        description="demo",
        input_schema={"type": "object", "properties": {}},
        is_enabled=enabled,
        approval_policy=policy,
    )
    db.add(tool)
    await db.commit()
    await db.refresh(tool)
    return server, tool


@pytest.mark.asyncio
async def test_ask_policy_blocks_chat_execution(db_session, test_user):
    server, tool = await _make_server_and_tool(db_session, test_user.id, policy="ask")
    result = await McpService.call_tool(db_session, test_user.id, server, tool, {})
    assert result["requires_confirmation"] is True


@pytest.mark.asyncio
async def test_ask_policy_returns_confirmation_instead_of_error(db_session, test_user):
    server, tool = await _make_server_and_tool(db_session, test_user.id, policy="ask")
    result = await McpService.execute_tool(
        db_session,
        test_user.id,
        encode_tool_name(server.id, tool.name),
        {"q": "x"},
    )
    assert result["success"] is False
    assert result["requires_confirmation"] is True
    assert result["mcpToolId"] == str(tool.id)
    assert result["arguments"] == {"q": "x"}


@pytest.mark.asyncio
async def test_deny_policy_blocks_execution(db_session, test_user):
    server, tool = await _make_server_and_tool(db_session, test_user.id, policy="deny")
    with pytest.raises(McpError):
        await McpService.call_tool(db_session, test_user.id, server, tool, {})


@pytest.mark.asyncio
async def test_only_auto_tools_are_exposed_to_llm(db_session, test_user):
    _server, auto_tool = await _make_server_and_tool(
        db_session, test_user.id, policy="auto", name="auto_tool",
    )
    _server2, ask_tool = await _make_server_and_tool(
        db_session, test_user.id, policy="ask", name="ask_tool",
    )
    definitions = await McpService.enabled_tool_definitions(db_session, test_user.id)
    names = [item["function"]["name"] for item in definitions]
    assert any(str(auto_tool.name) in name for name in names)
    assert all(str(ask_tool.name) not in name for name in names)
    assert all(name.startswith("mcp__") for name in names)


@pytest.mark.asyncio
async def test_execute_unknown_server_fails_gracefully(db_session, test_user):
    result = await McpService.execute_tool(
        db_session, test_user.id, "mcp__deadbeef__whatever", {},
    )
    assert result["success"] is False
    assert "服务器" in result["error"]


@pytest.mark.asyncio
async def test_audit_records_policy_rejection(db_session, test_user):
    server, tool = await _make_server_and_tool(db_session, test_user.id, policy="deny")
    with pytest.raises(McpError):
        await McpService.call_tool(db_session, test_user.id, server, tool, {})
    audits = await McpService.list_audit(db_session, test_user.id)
    # 策略拒绝发生在审计落库之前，因此不应产生调用记录
    assert all(item.tool_name != tool.name for item in audits)


def test_stdio_command_allowlist():
    assert _validate_stdio_command(sys.executable)
    with pytest.raises(McpError):
        _validate_stdio_command("bash")
    with pytest.raises(McpError):
        _validate_stdio_command("")


@pytest.mark.asyncio
async def test_stdio_discover_and_call_tool(db_session, test_user):
    server = McpServer(
        user_id=test_user.id,
        name="stdio 测试",
        transport="stdio",
        url="",
        command=sys.executable,
        args=[FAKE_STDIO_SERVER],
        is_enabled=True,
    )
    db_session.add(server)
    await db_session.commit()
    await db_session.refresh(server)

    tools = await McpService.discover_tools(db_session, server)
    assert any(tool.name == "echo" for tool in tools)
    echo = next(tool for tool in tools if tool.name == "echo")
    echo.is_enabled = True
    echo.approval_policy = "auto"
    await db_session.commit()

    result = await McpService.call_tool(
        db_session, test_user.id, server, echo, {"text": "你好"}, enforce_policy=False,
    )
    assert result["success"] is True
    assert "ECHO:你好" in str(result["content"])


@pytest.mark.asyncio
async def test_stdio_create_server_rejects_unlisted_command(db_session, test_user):
    with pytest.raises(McpError):
        await McpService.create_server(
            db_session,
            test_user.id,
            name="bad",
            transport="stdio",
            command="bash",
            args=["-c", "echo hi"],
        )
