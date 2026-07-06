"""Tests for AI tool registry."""
from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry


async def _sample_handler(
    db: AsyncSession,
    user_id: UUID,
    *,
    search: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    return {"success": True, "search": search, "limit": limit}


def test_filter_handler_kwargs_static_method():
    filtered = ToolRegistry._filter_handler_kwargs(
        _sample_handler,
        {"search": "hello", "limit": 10, "bogus": "drop"},
    )
    assert filtered == {"search": "hello", "limit": 10}
