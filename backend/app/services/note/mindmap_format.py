"""simple-mind-map JSON 规范化与大纲解析 — 供 AI 工具写入思维导图时使用。"""
from __future__ import annotations

import json
import re
from typing import Any

_BOX_BRANCH_RE = re.compile(r"^[\s│|]*(├──|└──|├─|└─|--|\|-)\s*")
_HEADER_RE = re.compile(r"^(#+)\s+(.+)$")
_BULLET_RE = re.compile(r"^[-*+]\s+(.+)$")
_NUMBERED_RE = re.compile(r"^\d+[.)]\s+(.+)$")


def _count_nodes(node: dict[str, Any]) -> int:
    total = 1
    for child in node.get("children") or []:
        if isinstance(child, dict):
            total += _count_nodes(child)
    return total


def _line_depth_and_text(line: str) -> tuple[int, str] | None:
    """解析单行大纲，返回 (depth, label)。"""
    raw = line.rstrip()
    if not raw.strip():
        return None

    stripped = raw.lstrip()
    indent = len(raw) - len(stripped)
    text = stripped

    header = _HEADER_RE.match(text)
    if header:
        return len(header.group(1)) - 1, header.group(2).strip()

    box = _BOX_BRANCH_RE.match(text)
    if box:
        marker = box.group(1)
        marker_pos = text.find(marker)
        pipe_prefix = text[:marker_pos] if marker_pos >= 0 else ""
        pipe_depth = pipe_prefix.count("│") + pipe_prefix.count("|")
        text = text[box.end() :].strip()
        depth = max(1, pipe_depth + 1)
        return depth, text

    bullet = _BULLET_RE.match(text)
    if bullet:
        depth = indent // 2
        if indent == 0:
            depth += raw[: len(raw) - len(stripped)].count("│") + raw[: len(raw) - len(stripped)].count("|")
        return depth, bullet.group(1).strip()

    numbered = _NUMBERED_RE.match(text)
    if numbered:
        depth = indent // 2
        return depth, numbered.group(1).strip()

    pipe_depth = raw[:indent].count("│") + raw[:indent].count("|")
    if pipe_depth:
        return pipe_depth, text.strip()
    return indent // 2, text.strip()


def _fix_outline_depths(items: list[tuple[int, str]]) -> list[tuple[int, str]]:
    """修正「标题 + 同级 bullet」等场景的层级。"""
    if len(items) <= 1:
        return items
    root_depth = items[0][0]
    fixed: list[tuple[int, str]] = [items[0]]
    offset = 0
    for d, t in items[1:]:
        if d <= root_depth:
            offset = root_depth + 1 - d
            fixed.append((d + offset, t))
        else:
            fixed.append((d + offset, t))
    return fixed


def _build_tree_from_items(items: list[tuple[int, str]], *, default_root: str = "中心主题") -> dict[str, Any]:
    """由 (depth, label) 列表构建 simple-mind-map 树。"""
    if not items:
        return {"data": {"text": default_root}, "children": []}

    min_depth = min(d for d, _ in items)
    if min_depth > 0:
        items = [(d - min_depth, t) for d, t in items]

    if items[0][0] != 0:
        root: dict[str, Any] = {"data": {"text": default_root}, "children": []}
        stack: list[tuple[int, dict[str, Any]]] = [(-1, root)]
        for depth, label in items:
            node = {"data": {"text": label}, "children": []}
            while stack and stack[-1][0] >= depth:
                stack.pop()
            stack[-1][1]["children"].append(node)
            stack.append((depth, node))
        return root

    root = {"data": {"text": items[0][1]}, "children": []}
    stack = [(0, root)]
    for depth, label in items[1:]:
        node = {"data": {"text": label}, "children": []}
        while stack and stack[-1][0] >= depth:
            stack.pop()
        stack[-1][1]["children"].append(node)
        stack.append((depth, node))
    return root


def parse_mindmap_outline(text: str, *, default_root: str = "中心主题") -> dict[str, Any]:
    """将树形/Markdown 大纲文本解析为 simple-mind-map JSON 树。"""
    items: list[tuple[int, str]] = []
    for line in text.strip().splitlines():
        parsed = _line_depth_and_text(line)
        if parsed:
            items.append(parsed)
    if not items:
        return {"data": {"text": default_root}, "children": []}
    if len(items) == 1:
        return {"data": {"text": items[0][1]}, "children": []}
    items = _fix_outline_depths(items)
    return _build_tree_from_items(items, default_root=default_root)


def parse_mindmap_sibling_nodes(text: str) -> list[dict[str, Any]]:
    """解析大纲为多个同级节点（用于 append_to_mindmap）。"""
    items: list[tuple[int, str]] = []
    for line in text.strip().splitlines():
        parsed = _line_depth_and_text(line)
        if parsed:
            items.append(parsed)
    if not items:
        return []

    depth0_indices = [i for i, (d, _) in enumerate(items) if d == 0]
    if len(depth0_indices) <= 1:
        tree = parse_mindmap_outline(text)
        children = tree.get("children") or []
        return children if children else [tree]

    nodes: list[dict[str, Any]] = []
    for idx, start in enumerate(depth0_indices):
        end = depth0_indices[idx + 1] if idx + 1 < len(depth0_indices) else len(items)
        chunk = [(d - items[start][0], t) for d, t in items[start:end]]
        nodes.append(_build_tree_from_items(chunk, default_root=chunk[0][1]))
    return nodes


def normalize_mindmap_children(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    children: list[dict[str, Any]] = []
    for item in raw:
        node = coerce_mindmap_node(item)
        if node:
            children.append(node)
    return children


def coerce_mindmap_node(raw: Any) -> dict[str, Any] | None:
    """将 AI 常见输出格式规范为 {data:{text}, children:[]} 节点。"""
    if raw is None:
        return None

    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        if text.startswith("{") or text.startswith("["):
            try:
                parsed = json.loads(text)
                return coerce_mindmap_node(parsed)
            except json.JSONDecodeError:
                pass
        if "\n" in text:
            return parse_mindmap_outline(text)
        return {"data": {"text": text}, "children": []}

    if not isinstance(raw, dict):
        return None

    data = raw.get("data")
    if isinstance(data, dict) and isinstance(data.get("text"), str):
        text = data.get("text", "").strip()
        children = normalize_mindmap_children(raw.get("children"))
        if "\n" in text and not children:
            expanded = parse_mindmap_outline(text)
            if _count_nodes(expanded) > 1:
                return expanded
        node: dict[str, Any] = {"data": {"text": text or "节点"}, "children": children}
        if data.get("uid"):
            node["data"]["uid"] = data["uid"]
        return node

    for key in ("text", "name", "label", "title", "value"):
        val = raw.get(key)
        if isinstance(val, str) and val.strip():
            text = val.strip()
            children = normalize_mindmap_children(
                raw.get("children") or raw.get("nodes") or raw.get("items")
            )
            if "\n" in text and not children:
                expanded = parse_mindmap_outline(text)
                if _count_nodes(expanded) > 1:
                    return expanded
            return {"data": {"text": text}, "children": children}

    return None


def normalize_mindmap_nodes(nodes: Any) -> list[dict[str, Any]]:
    """append_to_mindmap 的 nodes 参数规范化。"""
    if nodes is None:
        return []

    if isinstance(nodes, str):
        text = nodes.strip()
        if not text:
            return []
        if text.startswith("{") or text.startswith("["):
            try:
                nodes = json.loads(text)
            except json.JSONDecodeError:
                return parse_mindmap_sibling_nodes(text)
        else:
            return parse_mindmap_sibling_nodes(text)

    if isinstance(nodes, dict):
        coerced = coerce_mindmap_node(nodes)
        return [coerced] if coerced else []

    if isinstance(nodes, list):
        result: list[dict[str, Any]] = []
        for item in nodes:
            node = coerce_mindmap_node(item)
            if node:
                result.append(node)
        return result

    return []


def normalize_mindmap_content(content: Any) -> dict[str, Any] | None:
    """update_note / create_note 的 mindmap content 规范化。"""
    if content is None:
        return None

    if isinstance(content, str):
        text = content.strip()
        if not text:
            return None
        if text.startswith("{") or text.startswith("["):
            try:
                content = json.loads(text)
            except json.JSONDecodeError:
                return parse_mindmap_outline(text)
        else:
            return parse_mindmap_outline(text)

    if isinstance(content, dict):
        return coerce_mindmap_node(content)

    if isinstance(content, list):
        if not content:
            return {"data": {"text": "中心主题"}, "children": []}
        children = normalize_mindmap_nodes(content)
        return {"data": {"text": "中心主题"}, "children": children}

    return None
