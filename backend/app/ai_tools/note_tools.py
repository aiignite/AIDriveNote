"""Note tools — 笔记管理 CRUD for AI assistants."""
from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
from app.services.note.note_service import NoteService
from app.services.note.rich_text_blocks import (
    content_to_preview_text,
    merge_rich_text_blocks,
    parse_rich_text_content,
)

CATEGORY = "note"

# ---------- helpers ----------

_VALID_TYPES = ("rich_text", "markdown", "mindmap", "flowchart")


def _parse_uuid(raw: str, label: str = "note_id") -> UUID | dict:
    """Return UUID or error dict."""
    try:
        return UUID(raw)
    except ValueError:
        return {"success": False, "error": f"{label} 必须是有效的 UUID 格式，'{raw}' 无效"}


async def _check_owner(db: AsyncSession, nid: UUID, user_id: UUID) -> tuple[Any | None, dict | None]:
    """Return (note, None) or (None, error_dict)."""
    note = await NoteService.get_note(db, nid)
    if not note:
        return None, {"success": False, "error": f"未找到笔记 (id={nid})"}
    if note.created_by and note.created_by != user_id:
        return None, {"success": False, "error": "无权操作他人的笔记"}
    return note, None


# ---------- tool functions ----------

async def _list_notes(
    db: AsyncSession, user_id: UUID, *,
    search: str | None = None,
    note_type: str | None = None,
    folder_id: str | None = None,
    status: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    fid: UUID | None = None
    if folder_id:
        parsed = _parse_uuid(folder_id, "folder_id")
        if isinstance(parsed, dict):
            return parsed
        fid = parsed
    items, total = await NoteService.list_notes(
        db, skip=0, limit=limit,
        search=search, note_type=note_type, status=status,
        user_id=user_id, folder_id=fid,
    )
    return {
        "success": True, "total": total,
        "items": [
            {"id": str(n.id), "note_no": n.note_no, "title": n.title,
             "note_type": n.note_type, "status": n.status,
             "folder_id": str(n.folder_id) if n.folder_id else None,
             "updated_at": str(n.updated_at) if n.updated_at else None,
             "created_at": str(n.created_at) if n.created_at else None}
            for n in items[:limit]
        ],
    }


async def _get_note(db: AsyncSession, user_id: UUID, *, note_id: str) -> dict[str, Any]:
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    # 对 content 做友好展示：markdown 直接返回文本
    content = note.content
    content_summary = None
    if content and isinstance(content, dict):
        if note.note_type == "markdown" and "text" in content:
            content_summary = content["text"][:2000] if len(content.get("text", "")) > 2000 else None
        elif note.note_type == "mindmap" and "data" in content:
            content_summary = f"思维导图根节点: {content['data'].get('text', '?')}, 子节点数: {len(content.get('children', []))}"
    return {
        "success": True,
        "note": {
            "id": str(note.id), "note_no": note.note_no, "title": note.title,
            "note_type": note.note_type, "content": content,
            "content_summary": content_summary,
            "description": note.description, "status": note.status,
            "folder_id": str(note.folder_id) if note.folder_id else None,
            "created_at": str(note.created_at) if note.created_at else None,
            "updated_at": str(note.updated_at) if note.updated_at else None,
        },
    }


async def _create_note(
    db: AsyncSession, user_id: UUID, *,
    title: str,
    note_type: str = "markdown",
    content: dict | str | None = None,
    description: str | None = None,
    folder_id: str | None = None,
) -> dict[str, Any]:
    if note_type not in _VALID_TYPES:
        return {"success": False, "error": f"note_type 必须是 {'/'.join(_VALID_TYPES)} 之一，当前: {note_type}"}
    data: dict[str, Any] = {
        "title": title,
        "note_type": note_type,
        "status": "Active",
        "created_by": user_id,
        "updated_by": user_id,
    }
    # 智能包装 content
    if content is not None:
        data["content"] = _wrap_content(note_type, content)
    if description:
        data["description"] = description
    if folder_id:
        parsed = _parse_uuid(folder_id, "folder_id")
        if isinstance(parsed, dict):
            return parsed
        data["folder_id"] = parsed
    note = await NoteService.create_note(db, data)
    return {
        "success": True,
        "message": f"成功创建笔记「{title}」，编号: {note.note_no}",
        "note": {"id": str(note.id), "note_no": note.note_no, "title": note.title, "note_type": note.note_type},
    }


def _build_content_preview_result(
    note: Any,
    *,
    change_type: str,
    proposed_content: dict[str, Any],
    proposed_title: str | None = None,
    added_preview_text: str | None = None,
) -> dict[str, Any]:
    """生成待用户确认的笔记内容变更预览（不写入数据库）。"""
    return {
        "success": True,
        "preview": True,
        "requires_confirmation": True,
        "change_type": change_type,
        "note_id": str(note.id),
        "note_title": note.title,
        "note_type": note.note_type,
        "proposed_content": proposed_content,
        "proposed_title": proposed_title,
        "preview_text": content_to_preview_text(note.note_type, proposed_content),
        "current_preview_text": content_to_preview_text(note.note_type, note.content or {}),
        "added_preview_text": added_preview_text,
        "message": "笔记变更预览已生成，请在对话框中确认「应用到笔记」后才会写入",
    }


async def _update_note(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    title: str | None = None,
    content: dict | str | None = None,
    description: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err

    # Markdown / 富文本内容变更：仅生成预览，由用户在对话框确认后再写入
    if content is not None and note.note_type in ("markdown", "rich_text"):
        proposed_content = _wrap_content(note.note_type, content)
        if not proposed_content:
            return {"success": False, "error": "内容格式无效"}
        return _build_content_preview_result(
            note,
            change_type="update",
            proposed_content=proposed_content,
            proposed_title=title,
        )

    update: dict[str, Any] = {"updated_by": user_id}
    if title is not None:
        update["title"] = title
    if description is not None:
        update["description"] = description
    if status is not None:
        update["status"] = status
    if len(update) == 1:
        return {"success": False, "error": "没有提供需要更新的内容"}
    updated = await NoteService.update_note(db, parsed, update)
    if not updated:
        return {"success": False, "error": f"未找到笔记 (id={note_id})"}
    return {"success": True, "message": f"已更新笔记「{updated.title}」"}


async def _append_to_note(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    text: str,
) -> dict[str, Any]:
    """向笔记末尾追加内容（仅 markdown / rich_text 类型）。"""
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    if note.note_type not in ("markdown", "rich_text"):
        return {"success": False, "error": f"append_to_note 仅支持 markdown/rich_text 类型，当前笔记类型: {note.note_type}"}

    content = note.content or {}
    if note.note_type == "markdown":
        existing = content.get("text", "") if isinstance(content, dict) else ""
        new_text = existing + "\n\n" + text if existing else text
        new_content = {"text": new_text}
        added_preview = text
    else:
        new_content = merge_rich_text_blocks(content, text)
        extra_only = parse_rich_text_content(text)
        added_preview = content_to_preview_text("rich_text", extra_only)

    return _build_content_preview_result(
        note,
        change_type="append",
        proposed_content=new_content,
        added_preview_text=added_preview,
    )


async def _delete_note(db: AsyncSession, user_id: UUID, *, note_id: str) -> dict[str, Any]:
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    _note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    ok = await NoteService.delete_note(db, parsed)
    if not ok:
        return {"success": False, "error": f"未找到笔记 (id={note_id})"}
    return {"success": True, "message": "已删除笔记"}


async def _list_folders(db: AsyncSession, user_id: UUID) -> dict[str, Any]:
    from app.services.note.note_service import NoteFolderService

    folders = await NoteFolderService.list_folders(db, user_id)
    return {
        "success": True,
        "items": [
            {
                "id": str(f.id),
                "name": f.name,
                "parent_id": str(f.parent_id) if f.parent_id else None,
                "sort_order": f.sort_order,
            }
            for f in folders
        ],
    }


async def _move_note_to_folder(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    folder_id: str | None = None,
) -> dict[str, Any]:
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    update: dict[str, Any] = {"updated_by": user_id, "folder_id": None}
    if folder_id:
        fid = _parse_uuid(folder_id, "folder_id")
        if isinstance(fid, dict):
            return fid
        from app.services.note.note_service import NoteFolderService

        folder = await NoteFolderService.get_folder(db, fid)
        if not folder or folder.user_id != user_id:
            return {"success": False, "error": "文件夹不存在或无权访问"}
        update["folder_id"] = fid
    updated = await NoteService.update_note(db, parsed, update, save_revision=False)
    if not updated:
        return {"success": False, "error": f"未找到笔记 (id={note_id})"}
    return {"success": True, "message": f"已将笔记「{updated.title}」移动到指定文件夹"}


async def _list_templates(
    db: AsyncSession, user_id: UUID, *,  # noqa: ARG001
    note_type: str | None = None,
    search: str | None = None,
) -> dict[str, Any]:
    from app.services.note.note_service import NoteTemplateService

    items = await NoteTemplateService.list_templates(db, note_type=note_type, search=search)
    return {
        "success": True,
        "items": [
            {
                "id": str(t.id),
                "name": t.name,
                "note_type": t.note_type,
                "description": t.description,
                "is_builtin": t.is_builtin,
            }
            for t in items
        ],
    }


async def _create_note_from_template(
    db: AsyncSession, user_id: UUID, *,
    template_id: str,
    title: str | None = None,
    folder_id: str | None = None,
) -> dict[str, Any]:
    from app.services.note.note_service import NoteTemplateService

    tid = _parse_uuid(template_id, "template_id")
    if isinstance(tid, dict):
        return tid
    fid: UUID | None = None
    if folder_id:
        parsed = _parse_uuid(folder_id, "folder_id")
        if isinstance(parsed, dict):
            return parsed
        fid = parsed
    note = await NoteTemplateService.create_note_from_template(
        db, tid, user_id, folder_id=fid, title=title,
    )
    if not note:
        return {"success": False, "error": "模板不存在"}
    return {
        "success": True,
        "message": f"已从模板创建笔记「{note.title}」",
        "note": {"id": str(note.id), "note_no": note.note_no, "title": note.title},
    }


async def _list_note_tags(db: AsyncSession, user_id: UUID) -> dict[str, Any]:
    from app.services.note.note_enhance_service import NoteTagService

    tags = await NoteTagService.list_tags(db, user_id)
    return {
        "success": True,
        "items": [{"id": str(t.id), "name": t.name, "color": t.color} for t in tags],
    }


async def _add_tags_to_note(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    tag_names: list[str],
) -> dict[str, Any]:
    from app.services.note.note_enhance_service import NoteTagService

    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    added: list[str] = []
    for name in tag_names:
        name = name.strip()
        if not name:
            continue
        existing = await NoteTagService.list_tags(db, user_id)
        tag = next((t for t in existing if t.name == name), None)
        if not tag:
            tag = await NoteTagService.create_tag(db, user_id, name)
        ok = await NoteTagService.add_tag_to_note(db, parsed, tag.id, user_id)
        if ok:
            added.append(name)
    return {"success": True, "message": f"已添加标签: {', '.join(added) if added else '无'}"}


# ---------- content format helpers ----------

def _wrap_content(note_type: str, content: dict | str | list | None) -> dict | None:
    """将 AI 传入的 content 智能包装为对应类型的标准格式。"""
    if content is None:
        return None
    if note_type == "rich_text":
        return parse_rich_text_content(content)
    if isinstance(content, dict):
        return content
    text = str(content)
    if note_type == "markdown":
        return {"text": text}
    if note_type == "mindmap":
        return {"data": {"text": text}, "children": []}
    if note_type == "flowchart":
        return {"xml": text}
    return parse_rich_text_content(text)


def _register_all() -> None:
    ToolRegistry.register("list_notes", {
        "name": "list_notes",
        "description": "查询当前用户的笔记列表，支持按类型、状态、文件夹、关键词筛选。返回每条笔记的 id/标题/类型/状态/更新时间。",
        "parameters": {"type": "object", "properties": {
            "search": {"type": "string", "description": "搜索标题/描述关键词（可选）"},
            "note_type": {"type": "string", "enum": ["rich_text", "markdown", "mindmap", "flowchart"], "description": "笔记类型（可选）"},
            "folder_id": {"type": "string", "description": "按文件夹 UUID 过滤（可选）"},
            "status": {"type": "string", "enum": ["Active", "Draft", "Archived"], "description": "状态（可选）"},
            "limit": {"type": "integer", "description": "返回数量，默认 50"},
        }},
    }, _list_notes, CATEGORY, "查询笔记列表")

    ToolRegistry.register("get_note", {
        "name": "get_note",
        "description": "获取笔记详情，包括完整内容。Markdown 笔记内容在 content.text 中；思维导图在 content.data/children 中；富文本在 content.blocks 中；流程图在 content.xml 中。",
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
        }, "required": ["note_id"]},
    }, _get_note, CATEGORY, "获取笔记详情")

    ToolRegistry.register("create_note", {
        "name": "create_note",
        "description": (
            "创建新笔记。content 参数支持两种传入方式：\n"
            "1. 直接传字符串（推荐）：系统会自动包装为对应类型的格式\n"
            "2. 传 dict 对象：需自行构造格式（markdown: {text:...}, mindmap: {data:{text:...},children:[...]}, flowchart: {xml:...}, rich_text: {blocks:[...]}）"
        ),
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string", "description": "笔记标题"},
            "note_type": {"type": "string", "enum": ["rich_text", "markdown", "mindmap", "flowchart"], "description": "笔记类型，默认 markdown"},
            "content": {"description": "笔记内容，可以是字符串或对象（可选）"},
            "description": {"type": "string", "description": "笔记描述（可选）"},
            "folder_id": {"type": "string", "description": "放入的文件夹 UUID（可选）"},
        }, "required": ["title"]},
    }, _create_note, CATEGORY, "创建笔记")

    ToolRegistry.register("update_note", {
        "name": "update_note",
        "description": (
            "更新笔记内容或元数据。Markdown/富文本的 content 变更不会立即写入，"
            "会返回 preview 供用户在对话框确认。\n"
            "富文本 content 应传 {\"blocks\": [...]}（保留 heading/list 类型）或 Markdown 字符串。\n"
            "仅改标题/描述/状态时不触发预览，立即生效。末尾追加请用 append_to_note。"
        ),
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
            "title": {"type": "string", "description": "新标题（可选）"},
            "content": {"description": "新内容，字符串或 dict（可选）"},
            "description": {"type": "string", "description": "新描述（可选）"},
            "status": {"type": "string", "enum": ["Active", "Draft", "Archived"], "description": "新状态（可选）"},
        }, "required": ["note_id"]},
    }, _update_note, CATEGORY, "更新笔记")

    ToolRegistry.register("append_to_note", {
        "name": "append_to_note",
        "description": (
            "在 Markdown/富文本笔记末尾追加内容（续写/扩写）。不会立即写入，"
            "返回 preview 供用户确认。text 可用 Markdown（#/- 语法）或 JSON blocks。"
        ),
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
            "text": {"type": "string", "description": "要追加的文本内容"},
        }, "required": ["note_id", "text"]},
    }, _append_to_note, CATEGORY, "追加笔记内容")

    ToolRegistry.register("delete_note", {
        "name": "delete_note",
        "description": "删除一个笔记（逻辑删除）。",
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "要删除的笔记 UUID"},
        }, "required": ["note_id"]},
    }, _delete_note, CATEGORY, "删除笔记")

    ToolRegistry.register("list_note_folders", {
        "name": "list_note_folders",
        "description": "列出当前用户的笔记文件夹树，返回 id/名称/parent_id。",
        "parameters": {"type": "object", "properties": {}},
    }, _list_folders, CATEGORY, "列出文件夹")

    ToolRegistry.register("move_note_to_folder", {
        "name": "move_note_to_folder",
        "description": "将笔记移动到指定文件夹；folder_id 为空则移到根目录。",
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
            "folder_id": {"type": "string", "description": "目标文件夹 UUID（可选，空则根目录）"},
        }, "required": ["note_id"]},
    }, _move_note_to_folder, CATEGORY, "移动笔记到文件夹")

    ToolRegistry.register("list_note_templates", {
        "name": "list_note_templates",
        "description": "列出可用的笔记模板。",
        "parameters": {"type": "object", "properties": {
            "note_type": {"type": "string", "enum": ["rich_text", "markdown", "mindmap", "flowchart"]},
            "search": {"type": "string", "description": "按名称搜索"},
        }},
    }, _list_templates, CATEGORY, "列出笔记模板")

    ToolRegistry.register("create_note_from_template", {
        "name": "create_note_from_template",
        "description": "从模板创建新笔记。",
        "parameters": {"type": "object", "properties": {
            "template_id": {"type": "string", "description": "模板 UUID"},
            "title": {"type": "string", "description": "自定义标题（可选）"},
            "folder_id": {"type": "string", "description": "目标文件夹 UUID（可选）"},
        }, "required": ["template_id"]},
    }, _create_note_from_template, CATEGORY, "从模板创建笔记")

    ToolRegistry.register("list_note_tags", {
        "name": "list_note_tags",
        "description": "列出当前用户的所有笔记标签。",
        "parameters": {"type": "object", "properties": {}},
    }, _list_note_tags, CATEGORY, "列出笔记标签")

    ToolRegistry.register("add_tags_to_note", {
        "name": "add_tags_to_note",
        "description": "为笔记添加一个或多个标签（不存在则自动创建）。",
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
            "tag_names": {
                "type": "array",
                "items": {"type": "string"},
                "description": "标签名称列表",
            },
        }, "required": ["note_id", "tag_names"]},
    }, _add_tags_to_note, CATEGORY, "为笔记添加标签")


_register_all()
