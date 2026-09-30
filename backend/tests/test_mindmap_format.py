"""Tests for mindmap format normalization."""
from __future__ import annotations

from app.services.note.mindmap_format import (
    coerce_mindmap_node,
    normalize_mindmap_content,
    normalize_mindmap_nodes,
    parse_mindmap_outline,
)


def test_parse_box_outline() -> None:
    text = """产品规划
├── 用户研究
│   └── 访谈
└── 功能设计"""
    tree = parse_mindmap_outline(text)
    assert tree["data"]["text"] == "产品规划"
    assert len(tree["children"]) == 2
    assert tree["children"][0]["data"]["text"] == "用户研究"
    assert tree["children"][0]["children"][0]["data"]["text"] == "访谈"


def test_parse_markdown_bullets() -> None:
    text = """# 中心
- 分支 A
  - 子节点
- 分支 B"""
    tree = parse_mindmap_outline(text)
    assert tree["data"]["text"] == "中心"
    assert len(tree["children"]) == 2
    assert tree["children"][0]["children"][0]["data"]["text"] == "子节点"


def test_coerce_multiline_text_in_single_node() -> None:
    raw = {
        "data": {
            "text": "主题\n├── A\n└── B",
        },
        "children": [],
    }
    node = coerce_mindmap_node(raw)
    assert node is not None
    assert node["data"]["text"] == "主题"
    assert len(node["children"]) == 2


def test_coerce_alt_text_key() -> None:
    node = coerce_mindmap_node({"text": "节点A", "children": [{"text": "子1"}]})
    assert node is not None
    assert node["data"]["text"] == "节点A"
    assert node["children"][0]["data"]["text"] == "子1"


def test_normalize_mindmap_nodes_from_string_outline() -> None:
    nodes = normalize_mindmap_nodes("- 节点1\n  - 节点2\n- 节点3")
    assert len(nodes) == 2
    assert nodes[0]["data"]["text"] == "节点1"
    assert nodes[0]["children"][0]["data"]["text"] == "节点2"
    assert nodes[1]["data"]["text"] == "节点3"


def test_normalize_mindmap_content_from_outline_string() -> None:
    content = normalize_mindmap_content("架构\n├── 前端\n└── 后端")
    assert content is not None
    assert content["data"]["text"] == "架构"
    assert len(content["children"]) == 2


def test_normalize_mindmap_nodes_multiple_top_level() -> None:
    nodes = normalize_mindmap_nodes("分支A\n├── 子1\n└── 子2\n分支B")
    assert len(nodes) == 2
    assert nodes[0]["data"]["text"] == "分支A"
    assert len(nodes[0]["children"]) == 2
    assert nodes[1]["data"]["text"] == "分支B"


def test_normalize_mindmap_nodes_array_of_strings() -> None:
    nodes = normalize_mindmap_nodes(["分支1", "分支2"])
    assert len(nodes) == 2
    assert nodes[1]["data"]["text"] == "分支2"
