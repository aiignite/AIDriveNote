"""BlockNote 富文本 blocks 规范化 — AI 工具写入前统一格式，避免前端渲染错乱。"""
from __future__ import annotations

import json
import re
from typing import Any

VALID_BLOCK_TYPES = frozenset({
    "paragraph",
    "heading",
    "bulletListItem",
    "numberedListItem",
    "checkListItem",
    "codeBlock",
    "quote",
    "image",
})

BASE_PROPS: dict[str, Any] = {
    "textColor": "default",
    "backgroundColor": "default",
    "textAlignment": "left",
}


def _default_paragraph(text: str = "") -> dict[str, Any]:
    block: dict[str, Any] = {
        "type": "paragraph",
        "props": {**BASE_PROPS},
    }
    if text:
        block["content"] = [{"type": "text", "text": text, "styles": {}}]
    return block


def _normalize_inline_content(content: Any) -> list[dict[str, Any]]:
    if not isinstance(content, list):
        return []
    result: list[dict[str, Any]] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "link" and isinstance(item.get("href"), str):
            result.append({
                "type": "link",
                "href": item["href"],
                "content": _normalize_inline_content(item.get("content")),
            })
            continue
        result.append({
            "type": "text",
            "text": str(item.get("text", "")),
            "styles": item.get("styles") if isinstance(item.get("styles"), dict) else {},
        })
    return result


def _default_props_for_type(block_type: str, props: dict[str, Any]) -> dict[str, Any]:
    merged = {**BASE_PROPS, **props}
    if block_type == "heading":
        level = merged.get("level", 1)
        try:
            merged["level"] = max(1, min(3, int(level)))
        except (TypeError, ValueError):
            merged["level"] = 1
    if block_type == "checkListItem" and "checked" not in merged:
        merged["checked"] = False
    return merged


def _normalize_image_props(props: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {
        **BASE_PROPS,
        "name": str(props.get("name", "")),
        "url": str(props.get("url", "")),
        "caption": str(props.get("caption", "")),
        "showPreview": props.get("showPreview", True),
    }
    preview_width = props.get("previewWidth")
    if isinstance(preview_width, (int, float)):
        normalized["previewWidth"] = preview_width
    return normalized


def normalize_block(raw: Any) -> dict[str, Any]:
    """将单条 block 转为 BlockNote 兼容结构（剥离自定义 id，补全 props）。"""
    if not isinstance(raw, dict):
        return _default_paragraph(str(raw) if raw else "")

    block_type = raw.get("type")
    if block_type not in VALID_BLOCK_TYPES:
        block_type = "paragraph"

    if block_type == "image":
        props = raw.get("props") if isinstance(raw.get("props"), dict) else {}
        return {
            "type": "image",
            "props": _normalize_image_props(props),
        }

    props = raw.get("props") if isinstance(raw.get("props"), dict) else {}
    normalized: dict[str, Any] = {
        "type": block_type,
        "props": _default_props_for_type(str(block_type), props),
        "content": _normalize_inline_content(raw.get("content")),
    }

    children = raw.get("children")
    if isinstance(children, list) and children:
        normalized["children"] = normalize_blocks(children)

    return normalized


def normalize_blocks(raw_blocks: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_blocks, list) or not raw_blocks:
        return [_default_paragraph()]
    return [normalize_block(b) for b in raw_blocks]


def markdown_to_blocks(text: str) -> list[dict[str, Any]]:
    """将 Markdown 文本转为 BlockNote blocks（标题/列表/段落）。"""
    blocks: list[dict[str, Any]] = []
    for line in text.splitlines():
        stripped = line.rstrip()
        if not stripped.strip():
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            level = len(heading.group(1))
            blocks.append({
                "type": "heading",
                "props": {**BASE_PROPS, "level": level},
                "content": [{"type": "text", "text": heading.group(2).strip(), "styles": {}}],
            })
            continue

        bullet = re.match(r"^[-*+]\s+(.+)$", stripped)
        if bullet:
            blocks.append({
                "type": "bulletListItem",
                "props": {**BASE_PROPS},
                "content": [{"type": "text", "text": bullet.group(1).strip(), "styles": {}}],
            })
            continue

        numbered = re.match(r"^\d+\.\s+(.+)$", stripped)
        if numbered:
            blocks.append({
                "type": "numberedListItem",
                "props": {**BASE_PROPS},
                "content": [{"type": "text", "text": numbered.group(1).strip(), "styles": {}}],
            })
            continue

        blocks.append({
            "type": "paragraph",
            "props": {**BASE_PROPS},
            "content": [{"type": "text", "text": stripped.strip(), "styles": {}}],
        })

    return blocks or [_default_paragraph()]


def parse_rich_text_content(content: Any) -> dict[str, Any]:
    """将 AI/用户传入的多种 content 形态统一为 {blocks: [...]}。"""
    if content is None:
        return {"blocks": [_default_paragraph()]}

    if isinstance(content, list):
        return {"blocks": normalize_blocks(content)}

    if isinstance(content, dict):
        if isinstance(content.get("blocks"), list):
            return {"blocks": normalize_blocks(content["blocks"])}
        if content.get("type") in VALID_BLOCK_TYPES:
            return {"blocks": normalize_blocks([content])}
        return {"blocks": [_default_paragraph()]}

    text = str(content).strip()
    if not text:
        return {"blocks": [_default_paragraph()]}

    if text.startswith(("{", "[")):
        try:
            parsed = json.loads(text)
            return parse_rich_text_content(parsed)
        except json.JSONDecodeError:
            pass

    return {"blocks": markdown_to_blocks(text)}


def merge_rich_text_blocks(existing: Any, addition: Any) -> dict[str, Any]:
    """在已有 blocks 末尾追加内容（保留原有 block 结构）。"""
    base = parse_rich_text_content(existing if existing else None)
    extra = parse_rich_text_content(addition)
    return {"blocks": base["blocks"] + extra["blocks"]}


def _inline_text(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict):
            parts.append(str(item.get("text", "")))
    return "".join(parts)


def blocks_to_preview_text(blocks: list[dict[str, Any]], *, max_chars: int = 8000) -> str:
    """将 BlockNote blocks 转为可读 Markdown 预览文本。"""
    lines: list[str] = []
    for block in blocks:
        block_type = block.get("type", "paragraph")
        text = _inline_text(block.get("content"))
        props = block.get("props") if isinstance(block.get("props"), dict) else {}
        if block_type == "heading":
            level = int(props.get("level", 1) or 1)
            level = max(1, min(3, level))
            lines.append(f"{'#' * level} {text}".strip())
        elif block_type == "bulletListItem":
            lines.append(f"- {text}")
        elif block_type == "numberedListItem":
            lines.append(f"1. {text}")
        elif block_type == "checkListItem":
            checked = props.get("checked")
            mark = "x" if checked else " "
            lines.append(f"- [{mark}] {text}")
        elif block_type == "codeBlock":
            lines.append(f"```\n{text}\n```")
        elif block_type == "quote":
            lines.append(f"> {text}")
        elif block_type == "image":
            caption = str(props.get("caption") or props.get("name") or "图片")
            lines.append(f"![{caption}]")
        elif text:
            lines.append(text)
        else:
            lines.append("")
    preview = "\n".join(lines).strip()
    if len(preview) > max_chars:
        return preview[:max_chars] + "\n\n…（预览已截断）"
    return preview


def _mindmap_node_lines(node: dict[str, Any], depth: int = 0) -> list[str]:
    """将思维导图节点转为缩进大纲行。"""
    lines: list[str] = []
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    text = str(data.get("text", "")).strip() or "（空节点）"
    prefix = "  " * depth + ("- " if depth else "# ")
    lines.append(f"{prefix}{text}")
    children = node.get("children")
    if isinstance(children, list):
        for child in children:
            if isinstance(child, dict):
                lines.extend(_mindmap_node_lines(child, depth + 1))
    return lines


def mindmap_to_preview_text(content: dict[str, Any], *, max_chars: int = 8000) -> str:
    """思维导图 content → 缩进树形大纲。"""
    if not isinstance(content, dict):
        return ""
    preview = "\n".join(_mindmap_node_lines(content)).strip()
    if len(preview) > max_chars:
        return preview[:max_chars] + "\n\n…（预览已截断）"
    return preview or "（空导图）"


def flowchart_to_preview_text(content: dict[str, Any], *, max_chars: int = 8000) -> str:
    """流程图 content → mxCell 标签列表。"""
    xml = str(content.get("xml", "")) if isinstance(content, dict) else ""
    if not xml.strip():
        return "（空流程图）"
    labels = re.findall(r'value="([^"]*)"', xml)
    cleaned = [lbl.strip() for lbl in labels if lbl.strip()]
    if not cleaned:
        return "（流程图无文本节点）"
    lines = [f"{i + 1}. {label}" for i, label in enumerate(cleaned)]
    preview = "\n".join(lines)
    if len(preview) > max_chars:
        return preview[:max_chars] + "\n\n…（预览已截断）"
    return preview


def content_to_preview_text(note_type: str, content: dict[str, Any], *, max_chars: int = 8000) -> str:
    """将笔记 content JSON 转为对话框预览文本。"""
    if note_type == "markdown":
        text = str(content.get("text", ""))
        if len(text) > max_chars:
            return text[:max_chars] + "\n\n…（预览已截断）"
        return text
    if note_type == "rich_text":
        blocks = content.get("blocks")
        if isinstance(blocks, list):
            return blocks_to_preview_text(blocks, max_chars=max_chars)
    if note_type == "mindmap":
        return mindmap_to_preview_text(content, max_chars=max_chars)
    if note_type == "flowchart":
        return flowchart_to_preview_text(content, max_chars=max_chars)
    raw = json.dumps(content, ensure_ascii=False)
    return raw[:max_chars] + ("…" if len(raw) > max_chars else "")
