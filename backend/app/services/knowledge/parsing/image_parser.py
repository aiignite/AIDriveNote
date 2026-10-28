"""图片 OCR：pytesseract chi_sim+eng；不可用时返回空文本与警告。"""
from __future__ import annotations

import io
import logging

from app.services.knowledge.parsing.base import (
    ParsedDocument,
    normalize_text,
    truncate_text,
)

logger = logging.getLogger(__name__)


def parse_image(data: bytes) -> ParsedDocument:
    try:
        import pytesseract
        from PIL import Image

        image = Image.open(io.BytesIO(data))
        text = pytesseract.image_to_string(image, lang="chi_sim+eng", timeout=60)
        body = normalize_text(text)
        body, truncated = truncate_text(body)
        return ParsedDocument(
            text=body,
            parser="image",
            meta={"ocr": bool(body), "truncated": truncated},
        )
    except Exception as exc:  # noqa: BLE001 — OCR 是可选能力
        logger.warning("图片 OCR 失败或不可用: %s", exc)
        return ParsedDocument(
            text="",
            parser="image",
            meta={"ocr": False, "error": str(exc)[:200]},
        )
