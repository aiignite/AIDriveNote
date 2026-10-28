"""纯文本 / Markdown 解析。"""
from __future__ import annotations

from app.services.knowledge.parsing.base import (
    ParsedDocument,
    decode_bytes,
    normalize_text,
    truncate_text,
)


def parse_text_bytes(data: bytes) -> ParsedDocument:
    text, encoding = decode_bytes(data)
    text = normalize_text(text)
    text, truncated = truncate_text(text)
    return ParsedDocument(
        text=text,
        parser="text",
        meta={"encoding": encoding, "truncated": truncated, "chars": len(text)},
    )


def parse_plain_text(text: str) -> ParsedDocument:
    cleaned = normalize_text(text)
    cleaned, truncated = truncate_text(cleaned)
    return ParsedDocument(
        text=cleaned,
        parser="text",
        meta={"truncated": truncated, "chars": len(cleaned)},
    )
