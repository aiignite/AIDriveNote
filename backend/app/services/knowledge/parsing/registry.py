"""解析分发：按扩展名 / MIME 选择 parser。"""
from __future__ import annotations

import re
from pathlib import PurePosixPath

from app.services.knowledge.parsing.base import (
    ParsedDocument,
    ParseError,
    decode_bytes,
)
from app.services.knowledge.parsing.docx_parser import parse_docx
from app.services.knowledge.parsing.html_parser import parse_html
from app.services.knowledge.parsing.image_parser import parse_image
from app.services.knowledge.parsing.pdf_parser import parse_pdf
from app.services.knowledge.parsing.pptx_parser import parse_pptx
from app.services.knowledge.parsing.text_parser import parse_plain_text, parse_text_bytes
from app.services.knowledge.parsing.xlsx_parser import parse_xlsx

TEXT_SUFFIXES = {
    ".md", ".markdown", ".txt", ".csv", ".log", ".json", ".yaml", ".yml", ".xml", ".rst",
}
HTML_SUFFIXES = {".html", ".htm", ".xhtml"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
EXCEL_SUFFIXES = {".xlsx", ".xlsm"}

_HTML_HINT_RE = re.compile(r"<(?:html|body|div|p|br|table)\b", re.IGNORECASE)


def parse_bytes(
    data: bytes,
    *,
    filename: str | None = None,
    mime: str | None = None,
    allow_ocr: bool = True,
) -> ParsedDocument:
    suffix = PurePosixPath(filename or "").suffix.lower()
    mime_lower = (mime or "").lower()

    if suffix == ".pdf" or mime_lower == "application/pdf":
        return parse_pdf(data, allow_ocr=allow_ocr)
    if suffix == ".docx" or mime_lower in {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }:
        return parse_docx(data)
    if suffix in EXCEL_SUFFIXES or mime_lower in {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }:
        return parse_xlsx(data)
    if suffix == ".pptx" or mime_lower in {
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }:
        return parse_pptx(data)
    if suffix in HTML_SUFFIXES or mime_lower in {"text/html", "application/xhtml+xml"}:
        return parse_html(data)
    if suffix in IMAGE_SUFFIXES or mime_lower.startswith("image/"):
        return parse_image(data)

    if suffix in TEXT_SUFFIXES or mime_lower.startswith("text/"):
        return parse_text_bytes(data)

    # 未知扩展名：能当文本读就当文本，否则明确失败
    text, encoding = decode_bytes(data)
    printable = sum(1 for char in text[:4000] if char.isprintable() or char in "\n\t\r")
    if text and printable / max(len(text[:4000]), 1) > 0.85:
        parsed = parse_text_bytes(data)
        parsed.meta["encoding"] = encoding
        return parsed
    raise ParseError(f"暂不支持的文件类型: {filename or mime or 'unknown'}")


def parse_text(
    text: str,
    *,
    mime: str | None = None,
    title: str | None = None,
) -> ParsedDocument:
    mime_lower = (mime or "").lower()
    looks_html = mime_lower in {"text/html", "application/xhtml+xml"} or bool(
        _HTML_HINT_RE.search(text or "")
    )
    parsed = parse_html(text) if looks_html else parse_plain_text(text)
    if title:
        parsed.meta["title"] = title[:200]
    return parsed
