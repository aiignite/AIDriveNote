"""包入口：校验配置并启动 stdio MCP Server。"""
from __future__ import annotations

import sys

from .config import ConfigError, load_settings
from .server import create_server


def main() -> None:
    """启动 MCP Server。

    配置缺失时把中文指引写到 stderr 并退出，
    避免使用者在客户端日志里只看到空白报错无从排查。
    """
    try:
        settings = load_settings()
    except ConfigError as exc:
        print(f"[aidrivenote-mcp] 配置错误：{exc}", file=sys.stderr)
        raise SystemExit(1) from exc

    print(
        f"[aidrivenote-mcp] 启动成功，API 地址：{settings.base_url}",
        file=sys.stderr,
    )
    create_server(settings).run()


if __name__ == "__main__":
    main()