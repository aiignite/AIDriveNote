"""Execute AI tool calls."""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry


class ToolExecutor:
    def __init__(self, db: AsyncSession, user_id: UUID):
        self.db = db
        self.user_id = user_id

    def get_tools_for_assistant(self, assistant_tools: list[str] | None) -> list[dict[str, Any]]:
        return ToolRegistry.get_tools_for_names(assistant_tools)

    async def execute(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        # MCP 工具名带 mcp__ 前缀，交给 MCP 客户端执行（含授权策略与审计）
        if tool_name.startswith("mcp__"):
            from app.services.ai.mcp_service import McpService

            return await McpService.execute_tool(self.db, self.user_id, tool_name, arguments)
        return await ToolRegistry.execute(tool_name, self.db, self.user_id, **arguments)
