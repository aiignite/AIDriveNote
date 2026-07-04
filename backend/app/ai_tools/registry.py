"""Simplified AI tool registry for AIDriveNote."""
from __future__ import annotations

import inspect
import logging
from dataclasses import dataclass
from typing import Any, Callable, Coroutine
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

ToolHandler = Callable[..., Coroutine[Any, Any, dict[str, Any]]]


@dataclass
class RegisteredTool:
    name: str
    definition: dict[str, Any]
    handler: ToolHandler
    category: str
    label_zh: str


class ToolRegistry:
    _tools: dict[str, RegisteredTool] = {}
    _categories: dict[str, list[str]] = {}

    @classmethod
    def register(
        cls,
        name: str,
        definition: dict[str, Any],
        handler: ToolHandler,
        category: str,
        label_zh: str = "",
    ) -> None:
        cls._tools[name] = RegisteredTool(
            name=name,
            definition=definition,
            handler=handler,
            category=category,
            label_zh=label_zh or name,
        )
        cls._categories.setdefault(category, [])
        if name not in cls._categories[category]:
            cls._categories[category].append(name)

    @classmethod
    def get_tools_by_category(cls, category: str) -> list[str]:
        return cls._categories.get(category, [])

    @classmethod
    def get_all_definitions(cls) -> list[dict[str, Any]]:
        return [t.definition for t in cls._tools.values()]

    @classmethod
    def get_tools_for_names(cls, names: list[str] | None) -> list[dict[str, Any]]:
        if not names:
            return []
        return [cls._tools[n].definition for n in names if n in cls._tools]

    @classmethod
    def get_registry_metadata(cls) -> dict[str, Any]:
        categories = {}
        for cat, names in cls._categories.items():
            categories[cat] = [
                {"name": n, "label": cls._tools[n].label_zh}
                for n in names if n in cls._tools
            ]
        return {"categories": categories, "tools": cls.get_label_map()}

    @classmethod
    def get_label_map(cls) -> dict[str, str]:
        return {name: tool.label_zh for name, tool in cls._tools.items()}

    @classmethod
    def _filter_handler_kwargs(handler: ToolHandler, kwargs: dict[str, Any]) -> dict[str, Any]:
        sig = inspect.signature(handler)
        allowed = {
            name
            for name, param in sig.parameters.items()
            if name not in {"db", "user_id"}
            and param.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        }
        return {k: v for k, v in kwargs.items() if k in allowed}

    @classmethod
    async def execute(
        cls,
        tool_name: str,
        db: AsyncSession,
        user_id: UUID,
        **kwargs: Any,
    ) -> dict[str, Any]:
        tool = cls._tools.get(tool_name)
        if not tool:
            return {"success": False, "error": f"未知工具: {tool_name}"}
        try:
            handler_kwargs = cls._filter_handler_kwargs(tool.handler, kwargs)
            return await tool.handler(db, user_id, **handler_kwargs)
        except Exception as exc:
            logger.exception("Tool execution failed: %s", tool_name)
            try:
                await db.rollback()
            except Exception:
                pass
            return {"success": False, "error": str(exc)}
