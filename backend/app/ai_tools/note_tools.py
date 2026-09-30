"""Note tools — 笔记管理 CRUD for AI assistants."""
from __future__ import annotations

import json
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
from app.services.note.note_service import NoteService
from app.services.note.flowchart_format import normalize_flowchart_content
from app.services.note.mindmap_format import normalize_mindmap_content, normalize_mindmap_nodes
from app.services.note.rich_text_blocks import (
    content_to_preview_text,
    merge_rich_text_blocks,
    mindmap_to_preview_text,
    parse_rich_text_content,
)

CATEGORY = "note"

# ---------- helpers ----------

_VALID_TYPES = ("rich_text", "markdown", "mindmap", "flowchart")
_PREVIEW_CONTENT_TYPES = _VALID_TYPES
_SUMMARY_MAX = 2000


def _note_content_summary(note_type: str, content: dict[str, Any] | None) -> str | None:
    """生成笔记内容摘要（用于 get_note 默认返回）。"""
    if not content or not isinstance(content, dict):
        return None
    preview = content_to_preview_text(note_type, content, max_chars=_SUMMARY_MAX + 1)
    if not preview:
        return None
    if len(preview) > _SUMMARY_MAX:
        return preview[:_SUMMARY_MAX] + "…"
    return preview


def _validate_mindmap_content(content: dict[str, Any]) -> bool:
    data = content.get("data")
    return isinstance(data, dict) and isinstance(data.get("text"), str)


def _validate_flowchart_content(content: dict[str, Any]) -> bool:
    xml = content.get("xml")
    if not isinstance(xml, str) or not xml.strip():
        return False
    xml_stripped = xml.strip()
    return "mxCell" in xml_stripped or "mxGraphModel" in xml_stripped


def _find_mindmap_node(node: dict[str, Any], uid: str) -> dict[str, Any] | None:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    if str(data.get("uid", "")) == uid:
        return node
    children = node.get("children")
    if isinstance(children, list):
        for child in children:
            if isinstance(child, dict):
                found = _find_mindmap_node(child, uid)
                if found:
                    return found
    return None


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


async def _get_note(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    include_full_content: bool = False,
) -> dict[str, Any]:
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err

    content = note.content if isinstance(note.content, dict) else {}
    content_summary = _note_content_summary(note.note_type, content)
    return_content = content if include_full_content else None

    note_payload: dict[str, Any] = {
        "id": str(note.id), "note_no": note.note_no, "title": note.title,
        "note_type": note.note_type,
        "content_summary": content_summary,
        "description": note.description, "status": note.status,
        "folder_id": str(note.folder_id) if note.folder_id else None,
        "created_at": str(note.created_at) if note.created_at else None,
        "updated_at": str(note.updated_at) if note.updated_at else None,
    }
    if include_full_content:
        note_payload["content"] = content
    elif note.note_type in ("mindmap", "flowchart", "markdown", "rich_text"):
        note_payload["content"] = None
        note_payload["hint"] = "完整内容未返回以节省上下文；需要完整内容时请设置 include_full_content=true"

    return {"success": True, "note": note_payload}


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

    # 内容变更：生成预览，由用户在对话框确认后再写入
    if content is not None and note.note_type in _PREVIEW_CONTENT_TYPES:
        proposed_content = _wrap_content(note.note_type, content)
        if not proposed_content:
            return {"success": False, "error": "内容格式无效"}
        if note.note_type == "mindmap" and not _validate_mindmap_content(proposed_content):
            return {"success": False, "error": "思维导图 content 需包含 data.text 字段"}
        if note.note_type == "flowchart" and not _validate_flowchart_content(proposed_content):
            return {
                "success": False,
                "error": (
                    "流程图 content 需为 draw.io mxGraphModel XML（含 mxCell 节点），"
                    "不可使用纯文本树形描述"
                ),
            }
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


async def _append_to_mindmap(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    nodes: list | dict,
    parent_uid: str | None = None,
) -> dict[str, Any]:
    """向思维导图指定节点下追加子节点（默认根节点）。"""
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    if note.note_type != "mindmap":
        return {"success": False, "error": f"append_to_mindmap 仅支持 mindmap 类型，当前: {note.note_type}"}

    base = dict(note.content) if isinstance(note.content, dict) else {"data": {"text": "中心主题"}, "children": []}
    new_nodes = normalize_mindmap_nodes(nodes)
    if not new_nodes:
        return {"success": False, "error": "nodes 不能为空"}

    import copy
    merged = copy.deepcopy(base)
    target = merged
    if parent_uid:
        found = _find_mindmap_node(merged, parent_uid)
        if not found:
            return {"success": False, "error": f"未找到 parent_uid={parent_uid} 的节点"}
        if not isinstance(found.get("children"), list):
            found["children"] = []
        target = found

    if not isinstance(target.get("children"), list):
        target["children"] = []
    target["children"].extend(new_nodes)

    added_preview = "\n".join(
        mindmap_to_preview_text(n, max_chars=500) for n in new_nodes
    )
    return _build_content_preview_result(
        note,
        change_type="append",
        proposed_content=merged,
        added_preview_text=added_preview,
    )


async def _delete_note(
    db: AsyncSession, user_id: UUID, *,
    note_id: str,
    confirmed: bool = False,
) -> dict[str, Any]:
    parsed = _parse_uuid(note_id)
    if isinstance(parsed, dict):
        return parsed
    note, err = await _check_owner(db, parsed, user_id)
    if err:
        return err
    if not confirmed:
        return {
            "success": True,
            "preview": True,
            "requires_confirmation": True,
            "change_type": "delete",
            "note_id": str(note.id),
            "note_title": note.title,
            "note_type": note.note_type,
            "message": f"确认删除笔记「{note.title}」？请在对话框确认后才会执行删除。",
        }
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


async def _batch_summarize_notes(
    db: AsyncSession, user_id: UUID, *,
    note_ids: list[str] | None = None,
    folder_id: str | None = None,
    limit: int = 10,
) -> dict[str, Any]:
    """批量获取笔记摘要，供 AI 生成汇总报告。"""
    items: list[dict[str, Any]] = []
    if note_ids:
        for raw_id in note_ids[:limit]:
            result = await _get_note(db, user_id, note_id=raw_id, include_full_content=False)
            if result.get("success") and result.get("note"):
                n = result["note"]
                items.append({
                    "id": n["id"], "title": n["title"], "note_type": n["note_type"],
                    "summary": n.get("content_summary") or n.get("description") or "",
                })
    else:
        fid: UUID | None = None
        if folder_id:
            parsed = _parse_uuid(folder_id, "folder_id")
            if isinstance(parsed, dict):
                return parsed
            fid = parsed
        notes, _total = await NoteService.list_notes(
            db, skip=0, limit=limit, user_id=user_id, folder_id=fid,
        )
        for note in notes:
            content = note.content if isinstance(note.content, dict) else {}
            items.append({
                "id": str(note.id), "title": note.title, "note_type": note.note_type,
                "summary": _note_content_summary(note.note_type, content) or note.description or "",
            })
    return {"success": True, "count": len(items), "items": items}


async def _batch_add_tags(
    db: AsyncSession, user_id: UUID, *,
    note_ids: list[str],
    tag_names: list[str],
) -> dict[str, Any]:
    """为多篇笔记批量添加标签。"""
    results: list[dict[str, Any]] = []
    for raw_id in note_ids:
        result = await _add_tags_to_note(db, user_id, note_id=raw_id, tag_names=tag_names)
        results.append({"note_id": raw_id, **result})
    ok_count = sum(1 for r in results if r.get("success"))
    return {
        "success": ok_count > 0,
        "message": f"已为 {ok_count}/{len(note_ids)} 篇笔记添加标签",
        "results": results,
    }


# ---------- content format helpers ----------

def _wrap_content(note_type: str, content: dict | str | list | None) -> dict | None:
    """将 AI 传入的 content 智能包装为对应类型的标准格式。"""
    if content is None:
        return None
    if note_type == "rich_text":
        return parse_rich_text_content(content)
    if isinstance(content, dict):
        if note_type == "mindmap":
            normalized = normalize_mindmap_content(content)
            if normalized and _validate_mindmap_content(normalized):
                return normalized
            return None
        if note_type == "flowchart":
            if "xml" in content:
                return normalize_flowchart_content({"xml": str(content.get("xml") or "")})
            return None
        return content
    text = str(content)
    if note_type == "markdown":
        return {"text": text}
    if note_type == "mindmap":
        normalized = normalize_mindmap_content(text)
        if normalized and _validate_mindmap_content(normalized):
            return normalized
        return None
    if note_type == "flowchart":
        return normalize_flowchart_content({"xml": text})
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
        "description": (
            "获取笔记详情。默认返回 content_summary 摘要以节省上下文；"
            "需要完整 content 时设置 include_full_content=true。"
        ),
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
            "include_full_content": {"type": "boolean", "description": "是否返回完整 content，默认 false"},
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
            "更新笔记内容或元数据。所有类型的 content 变更均返回 preview 供用户确认。\n"
            "markdown/rich_text: 字符串或 blocks；"
            "mindmap: simple-mind-map JSON 树 {data:{text}, children:[]}，"
            "每个分支必须是独立节点，禁止将全部大纲塞进单个 data.text；"
            "flowchart: {xml} 且 xml 必须是含 mxCell 的 draw.io mxGraphModel XML。\n"
            "仅改标题/描述/状态时不触发预览，立即生效。末尾追加请用 append_to_note 或 append_to_mindmap。"
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

    ToolRegistry.register("append_to_mindmap", {
        "name": "append_to_mindmap",
        "description": (
            "向思维导图追加子节点。nodes 为 simple-mind-map 节点对象、节点数组，"
            "或树形/Markdown 大纲字符串；每个分支须为独立节点。"
            "parent_uid 指定父节点 uid，省略则追加到根节点下。返回 preview 供确认。"
        ),
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "笔记 UUID"},
            "nodes": {"description": "要追加的节点或节点数组"},
            "parent_uid": {"type": "string", "description": "父节点 uid（可选）"},
        }, "required": ["note_id", "nodes"]},
    }, _append_to_mindmap, CATEGORY, "追加导图节点")

    ToolRegistry.register("delete_note", {
        "name": "delete_note",
        "description": "删除笔记（逻辑删除）。首次调用返回确认预览，用户确认后需再次调用并设 confirmed=true。",
        "parameters": {"type": "object", "properties": {
            "note_id": {"type": "string", "description": "要删除的笔记 UUID"},
            "confirmed": {"type": "boolean", "description": "用户已确认删除时为 true"},
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

    ToolRegistry.register("batch_summarize_notes", {
        "name": "batch_summarize_notes",
        "description": "批量获取多篇笔记的摘要，用于生成汇总报告或对比分析。",
        "parameters": {"type": "object", "properties": {
            "note_ids": {
                "type": "array", "items": {"type": "string"},
                "description": "笔记 UUID 列表（与 folder_id 二选一）",
            },
            "folder_id": {"type": "string", "description": "文件夹 UUID，获取该文件夹下笔记摘要"},
            "limit": {"type": "integer", "description": "最多返回篇数，默认 10"},
        }},
    }, _batch_summarize_notes, CATEGORY, "批量笔记摘要")

    ToolRegistry.register("batch_add_tags", {
        "name": "batch_add_tags",
        "description": "为多篇笔记批量添加相同标签。",
        "parameters": {"type": "object", "properties": {
            "note_ids": {"type": "array", "items": {"type": "string"}, "description": "笔记 UUID 列表"},
            "tag_names": {"type": "array", "items": {"type": "string"}, "description": "标签名称列表"},
        }, "required": ["note_ids", "tag_names"]},
    }, _batch_add_tags, CATEGORY, "批量添加标签")


_register_all()
