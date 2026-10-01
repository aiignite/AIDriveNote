"""MCP 工具定义 — 把外部 Agent 检索到的文档写入 AIDriveNote 笔记。

对外暴露 5 个工具：
- create_note      把文档写入为新笔记（核心）
- append_to_note   追加内容到已有笔记
- search_notes     全文检索，用于定位目标笔记
- list_folders     列出文件夹，用于指定归档位置
- list_tags        列出标签，用于指定分类
"""
from __future__ import annotations

import re
from typing import Any

from mcp.server.fastmcp import FastMCP

from .client import AIDriveNoteClient, ApiError
from .config import Settings

# BlockNote 段落块的默认属性，与后端 rich_text_blocks 保持一致
BASE_PROPS: dict[str, Any] = {
    "textColor": "default",
    "backgroundColor": "default",
    "textAlignment": "left",
}


def _text_block(block_type: str, text: str, props: dict[str, Any] | None = None) -> dict[str, Any]:
    """构造一个 BlockNote 文本块。

    @param block_type 块类型（paragraph / heading / bulletListItem 等）
    @param text 块内文本
    @param props 追加的块属性
    @returns 块结构
    """
    return {
        "type": block_type,
        "props": {**BASE_PROPS, **(props or {})},
        "content": [{"type": "text", "text": text, "styles": {}}],
    }


def markdown_to_blocks(text: str) -> list[dict[str, Any]]:
    """把 Markdown 文本转为 BlockNote 块结构（行级尽力转换）。

    支持标题、无序列表、有序列表、待办列表、引用、代码围栏与普通段落；
    复杂排版（表格、嵌套列表）建议改用 markdown 笔记类型。

    @param text Markdown 文本
    @returns 块列表；空内容返回单段落块
    """
    blocks: list[dict[str, Any]] = []
    in_code = False
    code_lines: list[str] = []

    for raw_line in text.splitlines():
        line = raw_line.rstrip()

        # 代码围栏：成对出现，内容整体作为一个 codeBlock
        if line.strip().startswith("```"):
            if in_code:
                blocks.append(
                    _text_block("codeBlock", "\n".join(code_lines), {"language": "text"})
                )
                code_lines = []
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
            continue

        stripped = line.strip()
        if not stripped:
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading:
            blocks.append(
                _text_block("heading", heading.group(2).strip(), {"level": len(heading.group(1))})
            )
            continue

        todo = re.match(r"^[-*+]\s+\[([ xX])\]\s+(.+)$", stripped)
        if todo:
            blocks.append(
                _text_block(
                    "checkListItem",
                    todo.group(2).strip(),
                    {"checked": todo.group(1).lower() == "x"},
                )
            )
            continue

        bullet = re.match(r"^[-*+]\s+(.+)$", stripped)
        if bullet:
            blocks.append(_text_block("bulletListItem", bullet.group(1).strip()))
            continue

        numbered = re.match(r"^\d+\.\s+(.+)$", stripped)
        if numbered:
            blocks.append(_text_block("numberedListItem", numbered.group(1).strip()))
            continue

        quote = re.match(r"^>\s?(.+)$", stripped)
        if quote:
            blocks.append(_text_block("quote", quote.group(1).strip()))
            continue

        blocks.append(_text_block("paragraph", stripped))

    # 未闭合的代码围栏也要落盘，避免内容丢失
    if in_code and code_lines:
        blocks.append(_text_block("codeBlock", "\n".join(code_lines), {"language": "text"}))

    return blocks or [_text_block("paragraph", "")]


def _folder_paths(folders: list[dict[str, Any]]) -> list[str]:
    """把扁平文件夹列表渲染为「父/子」路径列表。

    @param folders 后端返回的文件夹列表（含 parent_id）
    @returns 已排序的路径字符串列表
    """
    by_id = {f["id"]: f for f in folders}

    def path_of(folder: dict[str, Any]) -> str:
        names = [folder["name"]]
        parent_id = folder.get("parent_id")
        seen = {folder["id"]}
        # 防御脏数据造成的环
        while parent_id and parent_id in by_id and parent_id not in seen:
            seen.add(parent_id)
            parent = by_id[parent_id]
            names.append(parent["name"])
            parent_id = parent.get("parent_id")
        return "/".join(reversed(names))

    return sorted(path_of(f) for f in folders)


def _match_folder(
    folders: list[dict[str, Any]], name: str,
) -> tuple[dict[str, Any] | None, str | None]:
    """按名称匹配文件夹。

    匹配策略：先精确匹配，再忽略大小写的包含匹配。
    命中 0 个或多个时返回错误提示，交由 Agent 向使用者确认，避免误建目录。

    @param folders 文件夹列表
    @param name 目标名称
    @returns (命中的文件夹, 错误信息)
    """
    target = name.strip()
    exact = [f for f in folders if f["name"] == target]
    if len(exact) == 1:
        return exact[0], None

    fuzzy = [f for f in folders if target.lower() in f["name"].lower()]
    if len(fuzzy) == 1:
        return fuzzy[0], None

    available = _folder_paths(folders)
    hint = "当前可用文件夹：\n" + ("\n".join(f"- {p}" for p in available) if available else "- （暂无文件夹）")
    if len(exact) + len(fuzzy) == 0:
        return None, f"未找到名为「{name}」的文件夹。{hint}\n如需新建文件夹，请先在笔记应用中创建。"
    return None, f"名称「{name}」匹配到多个文件夹，请使用更精确的名称。{hint}"


def _note_summary_line(note: dict[str, Any]) -> str:
    """把笔记对象格式化为一行摘要。

    @param note 笔记对象（snake_case 字段）
    @returns Markdown 列表项文本
    """
    preview = (note.get("preview_text") or "").replace("\n", " ").strip()
    if len(preview) > 80:
        preview = f"{preview[:80]}…"
    tail = f" — {preview}" if preview else ""
    return (
        f"- **{note.get('title', '(无标题)')}** "
        f"（{note.get('note_type', '')}，编号 {note.get('note_no', '')}，id `{note.get('id', '')}`）{tail}"
    )


def create_server(settings: Settings) -> FastMCP:
    """创建并注册全部工具的 MCP Server 实例。

    @param settings 运行期配置
    @returns 已注册工具的 FastMCP 实例
    """
    mcp = FastMCP("aidrivenote")

    @mcp.tool()
    async def list_folders() -> str:
        """列出当前账号的全部笔记文件夹（含层级路径）。

        在创建笔记前调用，可确认把文档归档到哪个文件夹。
        """
        try:
            async with AIDriveNoteClient(settings) as client:
                folders = await client.list_folders()
        except ApiError as exc:
            return f"获取文件夹失败：{exc}"

        if not folders:
            return "当前没有任何文件夹。可以直接创建笔记（不指定 folder_name），或在笔记应用中先建文件夹。"

        lines = ["当前文件夹（层级路径）："]
        lines.extend(f"- {path}" for path in _folder_paths(folders))
        return "\n".join(lines)

    @mcp.tool()
    async def list_tags() -> str:
        """列出当前账号的全部笔记标签。

        在创建笔记前调用，可确认标签命名，避免产生重复标签。
        """
        try:
            async with AIDriveNoteClient(settings) as client:
                tags = await client.list_tags()
        except ApiError as exc:
            return f"获取标签失败：{exc}"

        if not tags:
            return "当前没有任何标签。create_note 传入 tags 时会自动创建。"

        lines = ["当前标签："]
        lines.extend(f"- {t['name']}（{t.get('color', '')}）" for t in tags)
        return "\n".join(lines)

    @mcp.tool()
    async def search_notes(query: str, limit: int = 10) -> str:
        """全文检索笔记，用于定位要追加内容的已有笔记。

        @param query 检索关键词
        @param limit 返回条数上限（1-50）
        """
        limit = max(1, min(50, limit))
        try:
            async with AIDriveNoteClient(settings) as client:
                result = await client.search_notes(query, limit=limit)
        except ApiError as exc:
            return f"搜索失败：{exc}"

        items = result.get("items", [])
        if not items:
            return f"未检索到与「{query}」相关的笔记。"

        lines = [f"检索到 {result.get('total', len(items))} 篇与「{query}」相关的笔记（展示前 {len(items)} 篇）："]
        lines.extend(_note_summary_line(n) for n in items)
        lines.append("\n可用 append_to_note 配合上面的 id 追加内容。")
        return "\n".join(lines)

    @mcp.tool()
    async def create_note(
        title: str,
        content: str,
        note_type: str = "markdown",
        folder_name: str | None = None,
        tags: list[str] | None = None,
        description: str | None = None,
    ) -> str:
        """把一段文档写入为新的 AIDriveNote 笔记。

        @param title 笔记标题
        @param content 笔记正文，Markdown 文本
        @param note_type 笔记类型，markdown（默认，保留 Markdown 源码）或 rich_text（转为富文本块）
        @param folder_name 归档到的文件夹名称（需已存在，可先用 list_folders 确认）
        @param tags 标签名列表；不存在的标签会自动创建
        @param description 笔记描述（可选，用于列表展示）
        """
        if note_type not in ("markdown", "rich_text"):
            return "note_type 只能是 markdown 或 rich_text。"
        if not title.strip():
            return "标题不能为空。"
        if not content.strip():
            return "正文不能为空。"

        try:
            async with AIDriveNoteClient(settings) as client:
                folder_id: str | None = None
                if folder_name:
                    folders = await client.list_folders()
                    matched, error = _match_folder(folders, folder_name)
                    if error:
                        return error
                    folder_id = matched["id"] if matched else None

                payload: dict[str, Any] = {
                    "title": title.strip(),
                    "note_type": note_type,
                    "status": "Active",
                    "content": (
                        {"blocks": markdown_to_blocks(content)}
                        if note_type == "rich_text"
                        else {"text": content}
                    ),
                }
                if description:
                    payload["description"] = description
                if folder_id:
                    payload["folder_id"] = folder_id

                note = await client.create_note(payload)

                applied_tags: list[str] = []
                created_tags: list[str] = []
                if tags:
                    existing = await client.list_tags()
                    by_name = {t["name"]: t for t in existing}
                    for raw_tag in tags:
                        tag_name = raw_tag.strip()
                        if not tag_name:
                            continue
                        tag = by_name.get(tag_name)
                        if tag is None:
                            tag = await client.create_tag(tag_name)
                            by_name[tag_name] = tag
                            created_tags.append(tag_name)
                        await client.add_tag_to_note(note["id"], tag["id"])
                        applied_tags.append(tag_name)
        except ApiError as exc:
            return f"创建笔记失败：{exc}"

        lines = [
            f"已创建笔记「{note.get('title')}」（编号 {note.get('note_no')}，id `{note.get('id')}`）。",
        ]
        if folder_name:
            lines.append(f"- 归档文件夹：{folder_name}")
        if applied_tags:
            suffix = f"（其中新建：{'、'.join(created_tags)}）" if created_tags else ""
            lines.append(f"- 标签：{'、'.join(applied_tags)}{suffix}")
        lines.append("在笔记应用中搜索该标题即可打开。")
        return "\n".join(lines)

    @mcp.tool()
    async def append_to_note(
        content: str,
        note_id: str | None = None,
        title: str | None = None,
    ) -> str:
        """把 Markdown 内容追加到已有笔记的末尾。

        仅支持 markdown / rich_text 类型的笔记。
        note_id 与 title 至少提供一个；用 title 时会先搜索匹配，
        匹配到多篇时不会擅自写入，而是返回候选列表请你确认。

        @param content 待追加的 Markdown 文本
        @param note_id 目标笔记 id（优先使用）
        @param title 目标笔记标题关键词（用于搜索定位）
        """
        if not content.strip():
            return "追加内容不能为空。"
        if not note_id and not title:
            return "请至少提供 note_id 或 title 之一。"

        try:
            async with AIDriveNoteClient(settings) as client:
                target_id = note_id
                if not target_id and title:
                    result = await client.list_notes(search=title, limit=10)
                    items = result.get("items", [])
                    exact = [n for n in items if n.get("title") == title]
                    if len(exact) == 1:
                        target_id = exact[0]["id"]
                    elif len(items) == 1:
                        target_id = items[0]["id"]
                    elif not items:
                        return f"未找到标题包含「{title}」的笔记，可先用 search_notes 确认。"
                    else:
                        lines = [f"标题「{title}」匹配到多篇笔记，请改用 note_id 指定："]
                        lines.extend(_note_summary_line(n) for n in items)
                        return "\n".join(lines)

                note = await client.append_note(target_id, content)
        except ApiError as exc:
            return f"追加失败：{exc}"

        return (
            f"已向笔记「{note.get('title')}」（编号 {note.get('note_no')}）末尾追加内容。\n"
            "本次变更已自动生成修订记录，可在笔记的版本历史中查看。"
        )

    return mcp