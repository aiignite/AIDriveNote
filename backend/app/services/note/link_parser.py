"""Wiki link parsing and search text extraction for notes."""
from __future__ import annotations

import html as html_lib
import re
from typing import Any

from app.services.note.rich_text_blocks import content_to_preview_text

WIKI_LINK_PATTERN = re.compile(r"\[\[([^\]]+)\]\]")


def extract_wiki_links(content: dict | None, note_type: str) -> list[str]:
    """Extract [[link text]] from note content."""
    if not content:
        return []
    texts: list[str] = []
    if note_type == "markdown":
        text = content.get("text", "") if isinstance(content, dict) else str(content)
        texts.append(text)
    elif note_type == "rich_text":
        texts.append(content_to_preview_text(note_type, content))
    else:
        return []
    found: list[str] = []
    for text in texts:
        for match in WIKI_LINK_PATTERN.finditer(text):
            link_text = match.group(1).strip()
            if link_text and link_text not in found:
                found.append(link_text)
    return found


def build_search_text(
    title: str,
    description: str | None,
    content: dict | None,
    note_type: str,
    *,
    document_text: str | None = None,
) -> str:
    """Flatten note fields into plain text for full-text search."""
    parts = [title or ""]
    if description:
        parts.append(description)
    if note_type == "document":
        if document_text:
            parts.append(document_text)
        return " ".join(p for p in parts if p).strip()
    if content:
        if note_type == "markdown":
            parts.append(content.get("text", "") if isinstance(content, dict) else str(content))
        elif note_type == "rich_text":
            parts.append(content_to_preview_text(note_type, content))
        elif note_type == "mindmap":
            parts.append(_mindmap_text(content))
        elif note_type == "flowchart":
            parts.append(_flowchart_text(content))
    return " ".join(p for p in parts if p).strip()


def _flowchart_text(content: dict) -> str:
    """从 draw.io mxGraphModel XML 中抽取可见文字（节点/连线标签）。

    draw.io 把可见文字放在 mxCell 的 ``value`` 属性里（可能是转义过的
    HTML 片段），而不是元素文本节点，因此先取属性再反转义、去标签。
    """
    xml = content.get("xml") if isinstance(content, dict) else None
    if not xml or not isinstance(xml, str):
        return ""
    labels = re.findall(r'value="([^"]*)"', xml) + re.findall(r"value='([^']*)'", xml)
    raw = " ".join(labels)
    if not raw:
        # 兜底：没有 value 属性时取元素文本节点（导出格式可能不同）
        raw = re.sub(r"<[^>]+>", " ", xml)
    text_only = html_lib.unescape(raw)
    text_only = re.sub(r"<[^>]+>", " ", text_only)
    return " ".join(text_only.split())


def _mindmap_text(node: Any) -> str:
    if not isinstance(node, dict):
        return ""
    parts: list[str] = []
    data = node.get("data") or {}
    if isinstance(data, dict) and data.get("text"):
        parts.append(str(data["text"]))
    for child in node.get("children") or []:
        parts.append(_mindmap_text(child))
    return " ".join(parts)
