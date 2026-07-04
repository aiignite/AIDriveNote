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
        return await ToolRegistry.execute(tool_name, self.db, self.user_id, **arguments)
