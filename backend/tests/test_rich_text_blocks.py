"""Tests for BlockNote rich text block normalization."""
from __future__ import annotations

import json

from app.services.note.rich_text_blocks import (
    content_to_preview_text,
    flowchart_to_preview_text,
    markdown_to_blocks,
    merge_rich_text_blocks,
    mindmap_to_preview_text,
    normalize_blocks,
    parse_rich_text_content,
)


def test_parse_blocks_array_directly() -> None:
    raw = [{"type": "heading", "props": {"level": 1}, "content": [{"type": "text", "text": "Title", "styles": {}}]}]
    result = parse_rich_text_content(raw)
    assert result["blocks"][0]["type"] == "heading"
    assert result["blocks"][0]["props"]["level"] == 1
    assert result["blocks"][0]["props"]["textAlignment"] == "left"
    assert "id" not in result["blocks"][0]


def test_parse_json_string_blocks() -> None:
    payload = json.dumps({"blocks": [{"type": "paragraph", "content": [{"type": "text", "text": "Hi", "styles": {}}]}]})
    result = parse_rich_text_content(payload)
    assert result["blocks"][0]["type"] == "paragraph"
    assert result["blocks"][0]["content"][0]["text"] == "Hi"


def test_markdown_to_blocks_headings_and_lists() -> None:
    md = "# Title\n\n- item one\n- item two\n\nPlain paragraph"
    blocks = markdown_to_blocks(md)
    assert blocks[0]["type"] == "heading"
    assert blocks[0]["props"]["level"] == 1
    assert blocks[1]["type"] == "bulletListItem"
    assert blocks[2]["type"] == "bulletListItem"
    assert blocks[3]["type"] == "paragraph"


def test_merge_preserves_existing_structure() -> None:
    existing = {
        "blocks": [
            {"type": "heading", "props": {"level": 1}, "content": [{"type": "text", "text": "A", "styles": {}}]},
        ],
    }
    addition = "- new item"
    merged = merge_rich_text_blocks(existing, addition)
    assert merged["blocks"][0]["type"] == "heading"
    assert merged["blocks"][1]["type"] == "bulletListItem"


def test_normalize_strips_custom_id() -> None:
    raw = [{"id": "custom-id", "type": "paragraph", "props": {}, "content": [], "children": []}]
    blocks = normalize_blocks(raw)
    assert "id" not in blocks[0]
    assert blocks[0]["props"]["textColor"] == "default"


def test_normalize_preserves_image_block() -> None:
    raw = [{
        "type": "image",
        "props": {
            "url": "data:image/png;base64,abc",
            "name": "shot.png",
            "caption": "截图",
            "previewWidth": 320,
        },
    }]
    blocks = normalize_blocks(raw)
    assert blocks[0]["type"] == "image"
    assert blocks[0]["props"]["url"] == "data:image/png;base64,abc"
    assert blocks[0]["props"]["previewWidth"] == 320
    assert "content" not in blocks[0]


def test_mindmap_to_preview_text() -> None:
    tree = {
        "data": {"text": "Root"},
        "children": [
            {"data": {"text": "Child A"}, "children": []},
            {"data": {"text": "Child B"}, "children": [
                {"data": {"text": "Grandchild"}, "children": []},
            ]},
        ],
    }
    preview = mindmap_to_preview_text(tree)
    assert "# Root" in preview
    assert "Child A" in preview
    assert "Grandchild" in preview


def test_flowchart_to_preview_text() -> None:
    xml = '<mxCell id="1" value="开始"/><mxCell id="2" value="处理"/>'
    preview = flowchart_to_preview_text({"xml": xml})
    assert "1. 开始" in preview
    assert "2. 处理" in preview


def test_content_to_preview_text_mindmap() -> None:
    tree = {"data": {"text": "中心"}, "children": []}
    assert "中心" in content_to_preview_text("mindmap", tree)
