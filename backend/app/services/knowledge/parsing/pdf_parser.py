"""PDF 文本层抽取：清理跨页页眉页脚与页码。"""
from __future__ import annotations

import io
import logging
import re
from collections import Counter

from app.services.knowledge.parsing.base import (
    MAX_EXTRACTED_CHARS,
    ParsedDocument,
    ParseError,
    normalize_text,
    truncate_text,
)

logger = logging.getLogger(__name__)

MAX_PDF_PAGES = 200
MAX_OCR_PAGES = 20
_PAGE_NUMBER_RE = re.compile(
    r"^(?:[-–—]\s*)?(?:第\s*)?\d+(?:\s*页)?(?:\s*/\s*\d+)?(?:\s*[-–—])?$",
)


def _ocr_pdf(data: bytes) -> tuple[str, dict]:
    """渲染前若干页并 OCR；依赖缺失或失败时返回空文本。"""
    try:
        import pypdfium2 as pdfium
        import pytesseract
        from PIL import Image  # noqa: F401 — 确保 Pillow 可用
    except Exception:  # noqa: BLE001 — OCR 是可选能力
        return "", {"ocr": False}

    try:
        document = pdfium.PdfDocument(io.BytesIO(data))
        page_count = min(len(document), MAX_OCR_PAGES, MAX_PDF_PAGES)
        parts: list[str] = []
        for index in range(page_count):
            page = document[index]
            try:
                bitmap = page.render(scale=2.0)
                text = pytesseract.image_to_string(
                    bitmap.to_pil(), lang="chi_sim+eng", timeout=60,
                )
            finally:
                page.close()
            if text.strip():
                parts.append(text.strip())
        return "\n\n".join(parts), {"ocr": True, "ocr_pages": page_count}
    except Exception:  # noqa: BLE001
        logger.warning("PDF OCR 失败", exc_info=True)
        return "", {"ocr": False}


def _clean_pages(pages: list[list[str]]) -> list[str]:
    """剔除在多数页面重复出现的首/末行（页眉页脚）和纯页码行。"""
    if len(pages) < 3:
        return ["\n".join(lines).strip() for lines in pages]

    first = Counter(lines[0] for lines in pages if lines)
    last = Counter(lines[-1] for lines in pages if lines)
    threshold = max(3, len(pages) // 2)
    headers = {line for line, count in first.items() if count >= threshold and len(line) <= 120}
    footers = {line for line, count in last.items() if count >= threshold and len(line) <= 120}

    cleaned: list[str] = []
    for lines in pages:
        body = list(lines)
        if body and body[0] in headers:
            body = body[1:]
        if body and body[-1] in footers:
            body = body[:-1]
        body = [line for line in body if not _PAGE_NUMBER_RE.match(line.strip())]
        cleaned.append("\n".join(body).strip())
    return cleaned


def parse_pdf(data: bytes) -> ParsedDocument:
    try:
        from pypdf import PdfReader
    except Exception as exc:  # noqa: BLE001 — 依赖缺失时交给 worker 记录失败
        raise ParseError("pypdf 未安装，无法解析 PDF") from exc

    try:
        reader = PdfReader(io.BytesIO(data))
        total_pages = len(reader.pages)
        page_lines: list[list[str]] = []
        empty_pages = 0
        total_chars = 0
        for page in reader.pages[:MAX_PDF_PAGES]:
            text = page.extract_text() or ""
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            if not lines:
                empty_pages += 1
            page_lines.append(lines)
            total_chars += len(text)
            if total_chars >= MAX_EXTRACTED_CHARS:
                break
    except Exception as exc:  # noqa: BLE001 — 加密/损坏 PDF
        raise ParseError(f"PDF 读取失败: {exc}") from exc

    cleaned = _clean_pages(page_lines)
    body = normalize_text("\n\n".join(part for part in cleaned if part))
    body, truncated = truncate_text(body)
    parsed_pages = len(page_lines)
    text_layer = bool(body)
    text_layer_ratio = (
        (parsed_pages - empty_pages) / parsed_pages if parsed_pages else 0.0
    )

    ocr_used = False
    ocr_meta: dict = {}
    if not body or (text_layer_ratio < 0.5 and len(body) < 200):
        ocr_text, ocr_meta = _ocr_pdf(data)
        if len(ocr_text) > len(body):
            body = normalize_text(ocr_text)
            body, truncated = truncate_text(body)
            ocr_used = True

    return ParsedDocument(
        text=body,
        parser="pdf",
        meta={
            "pages": parsed_pages,
            "total_pages": total_pages,
            "empty_pages": empty_pages,
            "text_layer": text_layer,
            "text_layer_ratio": round(text_layer_ratio, 3),
            "ocr": ocr_used,
            **({"ocr_pages": ocr_meta.get("ocr_pages")} if ocr_used else {}),
            "truncated": truncated or total_pages > MAX_PDF_PAGES,
        },
    )
