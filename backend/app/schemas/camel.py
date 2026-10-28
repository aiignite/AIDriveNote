"""兼容外部脚本的 camelCase 请求体，内部统一成 snake_case。"""
from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, model_validator

_CAMEL_BOUNDARY = re.compile(r"(?<!^)(?=[A-Z])")


def camel_to_snake_keys(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    return {
        _CAMEL_BOUNDARY.sub("_", str(key)).lower(): value
        for key, value in data.items()
    }


class CamelRequest(BaseModel):
    """前端发 snake_case、Gmail/MCP 发 camelCase，都能被同一模型接收。"""

    model_config = ConfigDict(extra="ignore")

    @model_validator(mode="before")
    @classmethod
    def _normalize_keys(cls, data: Any) -> Any:
        return camel_to_snake_keys(data)
