"""解析层公共类型与文本归一化。"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MAX_EXTRACTED_CHARS = 200_000


class ParseError(RuntimeError):
    """解析失败；由 worker 记录 error 并重试。"""


@dataclass
class ParsedDocument:
    text: str
    parser: str
    meta: dict[str, Any] = field(default_factory=dict)


def decode_bytes(data: bytes) -> tuple[str, str]:
    """按 utf-8 → gb18030 → latin-1 依次尝试解码。"""
    for encoding in ("utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="ignore"), "utf-8-ignore"


def normalize_text(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def truncate_text(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_EXTRACTED_CHARS:
        return text, False
    return text[:MAX_EXTRACTED_CHARS], True
