"""笔记内容 → 邮件 HTML 正文渲染。

邮件客户端普遍不支持 CSS 布局与 JS，且普遍禁用外部资源加载，
因此这里的输出是「邮件安全」的保守 HTML：内联样式、无脚本、无外部引用。

各类型笔记的处理策略：

- ``markdown``：轻量子集渲染（标题/列表/代码/表格/强调/链接），不引入第三方库，
  避免为发一封邮件引入整条依赖链。
- ``rich_text``：BlockNote 的 blocks 结构，按块类型映射到 HTML 标签。
- ``mindmap``：递归渲染为嵌套列表（邮件里 ul/li 是最稳的树形表达）。
- ``flowchart``：drawio 的 XML 无法在邮件中渲染，转为等宽代码块展示原始 XML。
"""
from __future__ import annotations

import html
import re
from typing import Any

# ── 邮件内联样式表 ────────────────────────────────────────
# 邮件客户端会剥离 <style> 与 class，故所有样式必须写在元素的 style 属性上。
_STYLE_BODY = (
    "margin:0;padding:24px;background:#f5f5f5;"
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',"
    "'Hiragino Sans GB','Microsoft YaHei',sans-serif;"
)
_STYLE_CARD = (
    "max-width:720px;margin:0 auto;background:#ffffff;border-radius:12px;"
    "padding:28px 32px;box-shadow:0 1px 3px rgba(0,0,0,.08);"
)
_STYLE_H1 = "margin:0 0 8px;font-size:20px;font-weight:600;color:#111827;line-height:1.4;"
_STYLE_META = "margin:0 0 20px;font-size:12px;color:#9ca3af;border-bottom:1px solid #e5e7eb;padding-bottom:12px;"
_STYLE_H2 = "margin:24px 0 8px;font-size:16px;font-weight:600;color:#111827;"
_STYLE_H3 = "margin:18px 0 6px;font-size:14px;font-weight:600;color:#374151;"
_STYLE_P = "margin:0 0 12px;font-size:14px;line-height:1.75;color:#374151;"
_STYLE_UL = "margin:0 0 12px;padding-left:22px;font-size:14px;line-height:1.75;color:#374151;"
_STYLE_LI = "margin:0 0 4px;"
_STYLE_CODE = (
    "margin:0 0 12px;padding:12px 14px;background:#f9fafb;border:1px solid #e5e7eb;"
    "border-radius:8px;font-family:'SFMono-Regular',Consolas,Monaco,monospace;"
    "font-size:12px;line-height:1.6;color:#374151;overflow-x:auto;white-space:pre-wrap;word-break:break-word;"
)
_STYLE_QUOTE = (
    "margin:0 0 12px;padding:8px 14px;border-left:3px solid #d1d5db;"
    "color:#6b7280;font-size:13px;line-height:1.7;"
)
_STYLE_TABLE = "width:100%;border-collapse:collapse;margin:0 0 12px;font-size:13px;"
_STYLE_TH = "padding:8px 10px;background:#f9fafb;border:1px solid #e5e7eb;text-align:left;color:#111827;font-weight:600;"
_STYLE_TD = "padding:8px 10px;border:1px solid #e5e7eb;color:#374151;"
_STYLE_LINK = "color:#2563eb;text-decoration:none;"
_STYLE_HR = "border:none;border-top:1px solid #e5e7eb;margin:20px 0;"
_STYLE_FOOTER = (
    "max-width:720px;margin:16px auto 0;font-size:11px;color:#b0b5bd;text-align:center;line-height:1.7;"
)
_STYLE_IMG = "max-width:100%;height:auto;border-radius:8px;display:block;margin:0 0 12px;"


def _esc(text: Any) -> str:
    """HTML 转义（所有用户内容进入正文前都必须过这一关）。"""
    return html.escape(str(text if text is not None else ""))


# ── Markdown 轻量渲染 ─────────────────────────────────────

# 行内标记：代码 → 粗体 → 斜体 → 链接。顺序有讲究（先处理代码，
# 避免代码里的 * 被当成强调符号）。
_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_BOLD = re.compile(r"\*\*([^*]+)\*\*|__([^_]+)__")
_ITALIC = re.compile(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])")
_STRIKE = re.compile(r"~~([^~]+)~~")
_LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_FENCE = re.compile(r"^```(\w*)\s*$")
_UL_ITEM = re.compile(r"^\s*[-*+]\s+(.*)$")
_OL_ITEM = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_TABLE_SEP = re.compile(r"^\s*\|?[\s:-]*\|[\s:|-]*$")
_HR = re.compile(r"^\s*([-*_])\s*(\1\s*){2,}$")


def _render_inline(text: str) -> str:
    """渲染行内 Markdown。"""
    out = _esc(text)

    # 代码：内部已转义，直接包 <code>
    out = _INLINE_CODE.sub(lambda m: f'<code style="background:#f3f4f6;padding:1px 5px;'
                                    f'border-radius:4px;font-size:.92em;">{m.group(1)}</code>', out)
    out = _BOLD.sub(lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", out)
    out = _ITALIC.sub(lambda m: f"<em>{m.group(1) or m.group(2)}</em>", out)
    out = _STRIKE.sub(lambda m: f"<span style=\"text-decoration:line-through;\">{m.group(1)}</span>", out)

    # 链接：仅允许 http/https/mailto，其余退化为纯文本（防 javascript: 注入）
    def _link(m: re.Match[str]) -> str:
        label, href = m.group(1), m.group(2)
        if re.match(r"^(https?://|mailto:)", href, re.IGNORECASE):
            return f'<a href="{href}" style="{_STYLE_LINK}">{label}</a>'
        return label

    return _LINK.sub(_link, out)


def _split_table_row(line: str) -> list[str]:
    """拆分表格行单元格。"""
    return [c.strip() for c in line.strip().strip("|").split("|")]


def render_markdown(md: str) -> str:
    """把 Markdown 渲染为邮件安全 HTML。

    仅实现笔记里最常用的子集；未覆盖的语法按纯文本输出，不会丢内容。
    """
    lines = md.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    parts: list[str] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]

        # 代码块
        fence = _FENCE.match(line)
        if fence:
            lang = fence.group(1)
            body: list[str] = []
            i += 1
            while i < n and not _FENCE.match(lines[i]):
                body.append(lines[i])
                i += 1
            i += 1  # 跳过收尾 ```
            lang_hint = (f'<div style="font-size:11px;color:#9ca3af;margin-bottom:4px;">{_esc(lang)}</div>'
                         if lang else "")
            parts.append(
                f'<div style="{_STYLE_CODE}">{lang_hint}{_esc(chr(10).join(body))}</div>'
            )
            continue

        # 分割线
        if _HR.match(line):
            parts.append(f'<hr style="{_STYLE_HR}">')
            i += 1
            continue

        # 标题
        heading = _HEADING.match(line)
        if heading:
            level = len(heading.group(1))
            size = {1: 20, 2: 17, 3: 15}.get(level, 14)
            style = _STYLE_H1 if level == 1 else (_STYLE_H2 if level == 2 else _STYLE_H3)
            weight = "600" if level <= 2 else "500"
            parts.append(
                f'<p style="margin:{24 if level <= 2 else 18}px 0 8px;font-size:{size}px;'
                f'font-weight:{weight};color:#111827;line-height:1.4;">'
                f"{_render_inline(heading.group(2))}</p>"
            )
            i += 1
            continue

        # 表格：当前行含 | 且下一行是分隔行
        if "|" in line and i + 1 < n and _TABLE_SEP.match(lines[i + 1]) and "|" in lines[i + 1]:
            header = _split_table_row(line)
            i += 2
            body_rows: list[list[str]] = []
            while i < n and "|" in lines[i] and lines[i].strip():
                body_rows.append(_split_table_row(lines[i]))
                i += 1
            head_cells = "".join(f'<th style="{_STYLE_TH}">{_render_inline(c)}</th>' for c in header)
            rows_html = []
            for row in body_rows:
                # 补齐/截断列数，避免表格错位
                cells = list(row) + [""] * (len(header) - len(row))
                tds = "".join(f'<td style="{_STYLE_TD}">{_render_inline(c)}</td>' for c in cells[: len(header)])
                rows_html.append(f"<tr>{tds}</tr>")
            parts.append(
                f'<table style="{_STYLE_TABLE}"><thead><tr>{head_cells}</tr></thead>'
                f"<tbody>{''.join(rows_html)}</tbody></table>"
            )
            continue

        # 引用
        if _QUOTE.match(line):
            buf = []
            while i < n and _QUOTE.match(lines[i]):
                buf.append(_QUOTE.match(lines[i]).group(1))  # type: ignore[union-attr]
                i += 1
            parts.append(
                f'<blockquote style="{_STYLE_QUOTE}">{_render_inline(" ".join(buf).strip())}</blockquote>'
            )
            continue

        # 无序 / 有序列表
        if _UL_ITEM.match(line) or _OL_ITEM.match(line):
            ordered = bool(_OL_ITEM.match(line))
            items: list[str] = []
            while i < n:
                m = _OL_ITEM.match(lines[i]) if ordered else _UL_ITEM.match(lines[i])
                if m:
                    items.append(f'<li style="{_STYLE_LI}">{_render_inline(m.group(1))}</li>')
                    i += 1
                elif lines[i].startswith(("  ", "\t")) and items and lines[i].strip():
                    # 续行并入上一项，避免列表被空行截断
                    prev = items.pop() if items else ""
                    extra = lines[i].strip()
                    items.append(f"{prev[:-5]}{_render_inline(extra)}</li>")
                    i += 1
                else:
                    break
            tag = "ol" if ordered else "ul"
            parts.append(f'<{tag} style="{_STYLE_UL}">{"".join(items)}</{tag}>')
            continue

        # 空行
        if not line.strip():
            i += 1
            continue

        # 普通段落：连续非空行合并
        buf = [line.strip()]
        i += 1
        while i < n and lines[i].strip() and not _HEADING.match(lines[i]) \
                and not _FENCE.match(lines[i]) and not _HR.match(lines[i]) \
                and not _UL_ITEM.match(lines[i]) and not _OL_ITEM.match(lines[i]) \
                and not _QUOTE.match(lines[i]):
            buf.append(lines[i].strip())
            i += 1
        parts.append(f'<p style="{_STYLE_P}">{_render_inline(" ".join(buf))}</p>')

    return "".join(parts)


# ── 富文本（BlockNote blocks）渲染 ─────────────────────────

def _render_rich_text_blocks(blocks: list[Any]) -> str:
    """把 BlockNote blocks 渲染为 HTML。"""
    out: list[str] = []

    def render_link(link: dict[str, Any]) -> str:
        """渲染 link inline content。

        link 的 content 本身就是行内片段数组，必须整体交给 render_inline，
        逐项传入会让每个 dict 走兜底分支、把结构原样打印出来。
        """
        return render_inline(link.get("content"))

    def render_inline(content: Any) -> str:
        """渲染行内片段数组。

        BlockNote 的行内内容恒为数组 `[{"type":"text","text":...,"styles":{...}}]`，
        这里必须逐项处理；整体当标量转义会把结构原样打印出来。
        """
        if isinstance(content, str):
            return _esc(content)
        if not isinstance(content, list):
            return _esc(content)

        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(_esc(item))
                continue
            if not isinstance(item, dict):
                continue

            ctype = item.get("type")
            if ctype == "link":
                inner = render_link(item)
                href = str(item.get("href") or "")
                if re.match(r"^(https?://|mailto:)", href, re.IGNORECASE):
                    parts.append(f'<a href="{href}" style="{_STYLE_LINK}">{inner}</a>')
                else:
                    parts.append(inner)
                continue

            styles = item.get("styles") or {}
            rendered = _esc(item.get("text", ""))
            if styles.get("bold"):
                rendered = f"<strong>{rendered}</strong>"
            if styles.get("italic"):
                rendered = f"<em>{rendered}</em>"
            if styles.get("underline"):
                rendered = f"<u>{rendered}</u>"
            if styles.get("strike"):
                rendered = f'<span style="text-decoration:line-through;">{rendered}</span>'
            if styles.get("code"):
                rendered = (f'<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;'
                            f'font-size:.92em;">{rendered}</code>')
            parts.append(rendered)
        return "".join(parts)

    for block in blocks:
        if not isinstance(block, dict):
            out.append(f'<p style="{_STYLE_P}">{_esc(block)}</p>')
            continue

        btype = block.get("type", "paragraph")
        content = block.get("content")
        props = block.get("props", {}) or {}

        if btype == "heading":
            tag = "h2" if props.get("level", 1) <= 2 else "h3"
            style = _STYLE_H2 if tag == "h2" else _STYLE_H3
            out.append(f'<{tag} style="{style}">{render_inline(content)}</{tag}>')
        elif btype in ("bulletList", "orderedList"):
            # 列表块的 content 是二维数组：外层每项一个列表条目，内层才是行内片段
            items = content if isinstance(content, list) else []
            lis = "".join(
                f'<li style="{_STYLE_LI}">{render_inline(item)}</li>'
                for item in items
                if isinstance(item, (dict, list, str))
            )
            tag = "ol" if btype == "orderedList" else "ul"
            out.append(f'<{tag} style="{_STYLE_UL}">{lis}</{tag}>')
        elif btype == "codeBlock":
            lang = str(props.get("language") or "")
            hint = (f'<div style="font-size:11px;color:#9ca3af;margin-bottom:4px;">{_esc(lang)}</div>'
                    if lang else "")
            out.append(f'<div style="{_STYLE_CODE}">{hint}{render_inline(content)}</div>')
        elif btype == "quote":
            out.append(f'<blockquote style="{_STYLE_QUOTE}">{render_inline(content)}</blockquote>')
        elif btype == "image":
            # 图片 URL / 说明存在 props 里（content 对 image 块无意义）
            src = str(props.get("url") or "")
            alt = _esc(props.get("caption") or props.get("name") or "图片")
            if src.startswith(("http://", "https://")):
                out.append(f'<img src="{src}" alt="{alt}" style="{_STYLE_IMG}">')
            else:
                out.append(f'<p style="{_STYLE_P}">[图片：{alt}]</p>')
        elif btype in ("table", "tableRow"):
            out.append(f'<div style="{_STYLE_CODE}">{render_inline(content)}</div>')
        else:
            out.append(f'<p style="{_STYLE_P}">{render_inline(content)}</p>')

    return "".join(out)


# ── 思维导图渲染 ──────────────────────────────────────────

def _render_mindmap_node(node: Any, depth: int = 0) -> str:
    """递归渲染思维导图节点为嵌套列表。"""
    if not isinstance(node, dict):
        return ""

    data = node.get("data")
    label = _esc(data.get("text", "") if isinstance(data, dict) else node.get("text", ""))
    children = node.get("children") or []
    if not isinstance(children, list):
        children = []

    if not children:
        return f'<li style="{_STYLE_LI}">{label}</li>'

    # 缩进用 margin-left 表示层级，避免依赖 <ul> 默认缩进在邮件里表现不一
    indent = 0 if depth == 0 else 14
    inner = "".join(_render_mindmap_node(c, depth + 1) for c in children)
    return (
        f'<li style="{_STYLE_LI}">{label}'
        f'<ul style="{_STYLE_UL};margin:4px 0 0 {indent}px;padding-left:14px;">{inner}</ul></li>'
    )


def render_mindmap(content: Any) -> str:
    """渲染思维导图为嵌套列表。"""
    if not isinstance(content, dict):
        return ""
    label = _esc((content.get("data") or {}).get("text", "")) if isinstance(content.get("data"), dict) else ""
    children = content.get("children") or []
    if not isinstance(children, list):
        children = []
    if not children:
        return f'<p style="{_STYLE_P}">{label}</p>' if label else ""
    inner = "".join(_render_mindmap_node(c, 1) for c in children)
    root = f'<p style="{_STYLE_P};font-weight:600;color:#111827;">{label}</p>' if label else ""
    return f'{root}<ul style="{_STYLE_UL}">{inner}</ul>'


# ── 纯文本提取（用于邮件纯文本降级部件）────────────────────

def _plain_from_html(fragment: str) -> str:
    """把已转义的 HTML 片段退化为纯文本。"""
    text = re.sub(r"<br\s*/?>", "\n", fragment, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|li|h[1-6]|tr|blockquote)>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<li[^>]*>", "• ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text)


def build_note_html(
    *,
    title: str,
    note_type: str,
    content: Any,
    note_no: str = "",
    updated_at: str = "",
    sender_name: str = "",
) -> tuple[str, str]:
    """渲染完整邮件正文。

    :returns: ``(html_body, text_body)`` 二元组
    """
    fragment = _render_content(note_type, content)

    meta_bits: list[str] = []
    if note_no:
        meta_bits.append(f"编号 {_esc(note_no)}")
    if sender_name:
        meta_bits.append(f"由 {_esc(sender_name)} 分享")
    if updated_at:
        meta_bits.append(f"更新于 {_esc(updated_at)}")
    meta_line = " · ".join(meta_bits)

    body_html = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="{_STYLE_BODY}"><tr><td align="center">'
        f'<table role="presentation" width="720" cellpadding="0" cellspacing="0" '
        f'style="{_STYLE_CARD}">'
        f'<tr><td>'
        f'<h1 style="{_STYLE_H1}">{_esc(title)}</h1>'
        + (f'<p style="{_STYLE_META}">{meta_line}</p>' if meta_line else "")
        + fragment
        + f'</td></tr></table>'
        f'<p style="{_STYLE_FOOTER}">由 AIDriveNote 发送<br>'
        f'本邮件由笔记所有者主动分享，内容仅供收件人查阅。</p>'
        f"</td></tr></table>"
    )

    text_body = _plain_from_html(fragment).strip() or "（笔记内容为空）"
    text_body = f"{title}\n{'─' * max(len(title), 20)}\n\n{text_body}"

    return body_html, text_body


def _render_content(note_type: str, content: Any) -> str:
    """按笔记类型渲染正文片段。"""
    if content is None:
        return f'<p style="{_STYLE_P}">（笔记内容为空）</p>'

    if note_type == "markdown":
        raw = content.get("text") if isinstance(content, dict) else content
        text = str(raw or "").strip()
        return render_markdown(text) if text else f'<p style="{_STYLE_P}">（笔记内容为空）</p>'

    if note_type == "rich_text":
        blocks = content.get("blocks") if isinstance(content, dict) else content
        if isinstance(blocks, list) and blocks:
            return _render_rich_text_blocks(blocks)
        return f'<p style="{_STYLE_P}">（笔记内容为空）</p>'

    if note_type == "mindmap":
        rendered = render_mindmap(content)
        return rendered or f'<p style="{_STYLE_P}">（思维导图为空）</p>'

    if note_type == "flowchart":
        xml = content.get("xml") if isinstance(content, dict) else content
        xml_text = str(xml or "").strip()
        if not xml_text:
            return f'<p style="{_STYLE_P}">（流程图为空）</p>'
        # drawio XML 在邮件里无法渲染，截断展示以免撑爆邮件体积
        clipped = xml_text if len(xml_text) <= 4000 else xml_text[:4000] + "\n…（内容过长已截断）"
        return (
            f'<p style="{_STYLE_P}">流程图以 drawio XML 形式附上，可用 draw.io 打开：</p>'
            f'<div style="{_STYLE_CODE}">{_esc(clipped)}</div>'
        )

    # 未知类型：尽量按 JSON 文本呈现，避免静默丢内容
    return f'<div style="{_STYLE_CODE}">{_esc(str(content)[:4000])}</div>'
