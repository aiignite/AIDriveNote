"""笔记标题自动推导 —— 从内容里提取「最像标题」的文本。

各类型的取值规则：

- ``mindmap``：中心主题（根节点 ``data.text``）
- ``markdown``：第一行非空内容，去掉 ``#`` 等标记
- ``rich_text``：首个标题块；没有标题块时取第一个非空段落
- ``flowchart``：第一个 ``vertex="1"`` 节点的 ``value``（draw.io 里的第一个图形节点）

设计约束：**只在标题仍是占位值时才写入**，绝不覆盖用户手动起过的名字。
判定逻辑见 :func:`should_autofill_title`。
"""
from __future__ import annotations

import html
import re
from typing import Any

# 新建笔记时使用的占位标题。命中即视为「用户还没起过名」。
PLACEHOLDER_TITLES = {
    "无标题笔记",
    "无标题",
    "未命名",
    "未命名笔记",
    "untitled",
}

# 标题最大长度；超长时截断并加省略号（数据库字段 title 限长 200）
MAX_TITLE_LEN = 100

# Markdown 标题/列表/引用前缀
_MD_PREFIX = re.compile(r"^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+")

# HTML 标签（富文本里可能混入）
_HTML_TAG = re.compile(r"<[^>]+>")

# 连续空白
_WS = re.compile(r"\s+")


def _clean(raw: str) -> str:
    """清洗候选标题：去 HTML 标签、压空白、去 Markdown 标记、去首尾包裹符号。"""
    text = _HTML_TAG.sub(" ", raw)
    text = html.unescape(text)
    text = _MD_PREFIX.sub("", text)
    text = _WS.sub(" ", text).strip()
    # 去掉行首尾的常见装饰符号
    text = text.strip(" \t#>*_`~-|")
    return text


def _finalize(raw: str) -> str:
    """截断过长的标题。"""
    text = _clean(raw)
    if not text:
        return ""
    if len(text) > MAX_TITLE_LEN:
        text = text[: MAX_TITLE_LEN - 1].rstrip() + "…"
    return text


# ── 各类型提取 ──────────────────────────────────────────

def _title_from_markdown(content: Any) -> str:
    """Markdown：取第一行非空内容。

    优先找第一个标题行（``# xxx``）——它是最明确的标题信号；
    没有标题行则用第一段正文的第一行。
    """
    text = content.get("text") if isinstance(content, dict) else content
    if not isinstance(text, str) or not text.strip():
        return ""

    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    # 第一轮：找第一个标题行
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            return _finalize(stripped.lstrip("#").strip())
        # 遇到正文就停（标题只可能在开头区域）
        break

    # 第二轮：正文第一行
    for line in lines:
        stripped = line.strip()
        if stripped:
            return _finalize(stripped)
    return ""


def _title_from_rich_text(content: Any) -> str:
    """富文本：优先首个 heading 块，否则第一个非空段落。"""
    blocks = content.get("blocks") if isinstance(content, dict) else content
    if not isinstance(blocks, list):
        return ""

    def block_text(block: Any) -> str:
        """取块内所有行内片段拼接的纯文本。"""
        if not isinstance(block, dict):
            return ""
        parts: list[str] = []
        for item in block.get("content") or []:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "link":
                    parts.extend(block_text({"content": item.get("content")}))
                else:
                    parts.append(str(item.get("text", "")))
        return "".join(parts)

    heading_text = ""
    first_paragraph = ""
    for block in blocks:
        if not isinstance(block, dict):
            continue
        text = block_text(block).strip()
        if not text:
            continue
        btype = block.get("type", "paragraph")
        if btype == "heading" and not heading_text:
            heading_text = text
            # 标题块之后不再找正文，直接用标题
            return _finalize(heading_text)
        if btype in ("paragraph", "bulletList", "orderedList") and not first_paragraph:
            first_paragraph = text
    return _finalize(first_paragraph)


def _title_from_mindmap(content: Any) -> str:
    """思维导图：取中心主题（根节点 data.text）。"""
    if not isinstance(content, dict):
        return ""
    data = content.get("data")
    if isinstance(data, dict):
        text = data.get("text")
        if isinstance(text, str) and text.strip():
            return _finalize(text)
    # 兼容纯 text 字段
    text = content.get("text")
    if isinstance(text, str) and text.strip():
        return _finalize(text)
    return ""


# mxCell 中 value 属性里的 HTML 实体与换行
_MX_VALUE_RE = re.compile(r'<mxCell\b[^>]*?\bvalue\s*=\s*"([^"]*)"', re.IGNORECASE)
# vertex="1" 表示这是一个图形节点（排除连线 edge 与根节点 id 0/1）
_MX_VERTEX_RE = re.compile(r'<mxCell\b[^>]*\bvertex\s*=\s*"1"', re.IGNORECASE)


def _title_from_flowchart(content: Any) -> str:
    """流程图：取第一个图形节点的文字。

    draw.io 的 mxCell 里 ``vertex="1"`` 才是节点；``value`` 里可能带 HTML 标签
    （如 ``&lt;b&gt;`` 或 ``&amp;nbsp;``），需清洗后再用。
    """
    xml = content.get("xml") if isinstance(content, dict) else content
    if not isinstance(xml, str) or not xml.strip():
        return ""

    # 逐个 mxCell 找，先出现的 vertex 节点优先
    for cell_match in re.finditer(r"<mxCell\b[^>]*>", xml, re.IGNORECASE):
        cell = cell_match.group(0)
        if not _MX_VERTEX_RE.search(cell):
            continue
        value_match = _MX_VALUE_RE.search(cell)
        if not value_match:
            continue
        raw = html.unescape(value_match.group(1))
        # value 内部还可能是 HTML 片段
        raw = re.sub(r"<br\s*/?>", " ", raw, flags=re.IGNORECASE)
        candidate = _finalize(raw)
        if candidate:
            return candidate

    # 兜底：没找到带 value 的顶点，退而取任意节点的 value
    for value_match in _MX_VALUE_RE.finditer(xml):
        candidate = _finalize(html.unescape(value_match.group(1)))
        if candidate:
            return candidate
    return ""


_EXTRACTORS = {
    "mindmap": _title_from_mindmap,
    "markdown": _title_from_markdown,
    "rich_text": _title_from_rich_text,
    "flowchart": _title_from_flowchart,
}


def derive_title(note_type: str, content: Any) -> str:
    """从笔记内容推导标题。

    :param note_type: 笔记类型
    :param content: 笔记内容
    :returns: 推导出的标题；无法推导时返回空字符串
    """
    extractor = _EXTRACTORS.get(note_type)
    if not extractor:
        return ""
    try:
        return extractor(content)
    except Exception:  # noqa: BLE001 - 标题推导失败不应影响保存主流程
        return ""


def is_placeholder_title(title: str | None) -> bool:
    """判断标题是否仍是占位值（用户未起过名）。"""
    if not title:
        return True
    normalized = _WS.sub("", title).strip().lower()
    if not normalized:
        return True
    return normalized in {t.lower() for t in PLACEHOLDER_TITLES}


def should_autofill_title(current_title: str | None, note_type: str, content: Any) -> str:
    """在标题仍为占位值时，用内容推导结果填充。

    这是「仅填充占位标题」策略的唯一入口：用户手动改过的标题一律不动。

    :param current_title: 当前标题
    :param note_type: 笔记类型
    :param content: 笔记内容
    :returns: 需要写入的新标题；不应改写时返回空字符串
    """
    if not is_placeholder_title(current_title):
        return ""
    return derive_title(note_type, content)
