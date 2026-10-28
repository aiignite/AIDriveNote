"""极简 stdio MCP 服务器，用于客户端回归测试（换行分隔 JSON-RPC）。"""
from __future__ import annotations

import json
import sys


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "id" not in message:
            continue  # notification
        method = message.get("method")
        if method == "initialize":
            result = {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "serverInfo": {"name": "fake", "version": "1.0"},
            }
        elif method == "tools/list":
            result = {
                "tools": [{
                    "name": "echo",
                    "description": "回显文本",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"text": {"type": "string"}},
                    },
                }],
            }
        elif method == "tools/call":
            arguments = (message.get("params") or {}).get("arguments") or {}
            result = {"content": [{"type": "text", "text": f"ECHO:{arguments.get('text', '')}"}]}
        else:
            result = {}
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
