"""HTML / 邮件正文抽取：trafilatura 优先，BeautifulSoup 兜底。"""
from __future__ import annotations

import logging
import re

from app.services.knowledge.parsing.base import (
    ParsedDocument,
    decode_bytes,
    normalize_text,
    truncate_text,
)

logger = logging.getLogger(__name__)

_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_H1_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)


def _strip_tags(value: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", value or "")).strip()


def _extract_title(html: str) -> str | None:
    for pattern in (_TITLE_RE, _H1_RE):
        match = pattern.search(html)
        if match:
            title = _strip_tags(match.group(1))
            if title:
                return title[:200]
    return None


def parse_html(data: bytes | str) -> ParsedDocument:
    html = decode_bytes(data)[0] if isinstance(data, bytes) else data
    title = _extract_title(html)
    text = ""
    extractor = ""

    try:
        import trafilatura

        text = trafilatura.extract(
            html,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        ) or ""
        extractor = "trafilatura"
    except Exception:  # noqa: BLE001 — trafilatura 可选
        logger.debug("trafilatura 不可用，回退 BeautifulSoup", exc_info=True)

    if not text.strip():
        try:
            from bs4 import BeautifulSoup

            soup = BeautifulSoup(html, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header", "aside", "form"]):
                tag.decompose()
            text = soup.get_text("\n")
            extractor = "bs4"
        except Exception:  # noqa: BLE001 — bs4 也未安装时用正则兜底
            text = re.sub(r"<[^>]+>", "\n", html)
            extractor = "regex"

    body = normalize_text(text)
    body, truncated = truncate_text(body)
    return ParsedDocument(
        text=body,
        parser="html",
        meta={
            "extractor": extractor,
            "title": title,
            "truncated": truncated,
            "chars": len(body),
        },
    )
