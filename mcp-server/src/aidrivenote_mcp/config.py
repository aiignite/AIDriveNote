"""MCP Server 配置读取与环境变量校验。"""
from __future__ import annotations

import os
from dataclasses import dataclass

# 生产环境默认 API 根地址（当前为 /note 子路径部署）
DEFAULT_BASE_URL = "https://www.aiignite.com.cn/note/api/v1"
# 默认请求超时（秒）
DEFAULT_TIMEOUT = 30.0


class ConfigError(RuntimeError):
    """配置缺失或不合法；由入口捕获后打印中文指引。"""


@dataclass(frozen=True)
class Settings:
    """MCP Server 运行期配置。"""

    # 后端 API 根地址，例如 https://example.com/note/api/v1（不带结尾斜杠）
    base_url: str
    # 个人访问令牌（adn_ 前缀）
    api_token: str
    # 单次请求超时秒数
    timeout: float


def load_settings() -> Settings:
    """从环境变量加载配置。

    @returns Settings 实例
    @raises ConfigError 未配置访问令牌，或超时值非法
    """
    token = (os.getenv("AIDRIVENOTE_API_TOKEN") or "").strip()
    if not token:
        raise ConfigError(
            "未配置环境变量 AIDRIVENOTE_API_TOKEN。\n"
            "请先在笔记应用「设置 → 访问令牌」生成令牌，再写入 MCP 配置的 env 段，例如：\n"
            '  "env": {\n'
            '    "AIDRIVENOTE_BASE_URL": "https://www.aiignite.com.cn/note/api/v1",\n'
            '    "AIDRIVENOTE_API_TOKEN": "adn_xxxxxxxx"\n'
            "  }"
        )

    base_url = (os.getenv("AIDRIVENOTE_BASE_URL") or DEFAULT_BASE_URL).strip().rstrip("/")
    if not base_url:
        base_url = DEFAULT_BASE_URL

    raw_timeout = (os.getenv("AIDRIVENOTE_TIMEOUT") or "").strip()
    try:
        timeout = float(raw_timeout) if raw_timeout else DEFAULT_TIMEOUT
    except ValueError as exc:
        raise ConfigError(
            f"AIDRIVENOTE_TIMEOUT 必须是数字，当前值: {raw_timeout}"
        ) from exc
    if timeout <= 0:
        raise ConfigError(f"AIDRIVENOTE_TIMEOUT 必须大于 0，当前值: {timeout}")

    return Settings(base_url=base_url, api_token=token, timeout=timeout)