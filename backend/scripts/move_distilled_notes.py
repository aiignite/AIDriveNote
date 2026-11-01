"""一次性整理：把散落在笔记树根目录的蒸馏产物移入「蒸馏产出」目录。

用法（在 backend 目录下）::

    python -m scripts.move_distilled_notes                 # 预演：移动仍存活的根级蒸馏笔记
    python -m scripts.move_distilled_notes --apply         # 实际移动
    python -m scripts.move_distilled_notes --restore       # 预演：回收站里的蒸馏笔记先恢复再移动
    python -m scripts.move_distilled_notes --restore --apply

判定标准：存在 ``note_sources`` 记录 —— 只有知识卡编译出来的笔记才有来源记录。
``--restore`` 额外处理回收站中（``is_deleted``）的蒸馏笔记：恢复后如果位于根目录，
一并归档。目标目录按 ``kb:`` 标签推导（与后端 ``ensure_distill_folder`` 规则一致）。
脚本幂等：移动后笔记不再位于根目录，重复执行不会二次处理。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

os.environ.setdefault("AIDRIVE_TESTING", "1")

from sqlalchemy import select  # noqa: E402

from app.database import AsyncSessionLocal  # noqa: E402
from app.models.knowledge import NoteSource  # noqa: E402
from app.models.note.note import Note, NoteFolder, NoteNoteTag, NoteTag  # noqa: E402
from app.services.note.note_service import NoteFolderService  # noqa: E402

# 与 knowledge_compile_service 保持一致；脚本自包含，可在旧镜像上直接运行
DISTILL_ROOT_NAME = "蒸馏产出"
KB_DIRS = {
    "concept": "concepts",
    "entity": "entities",
    "topic": "topics",
    "decision": "decisions",
    "note": "topics",
}


async def _get_or_create_folder(db, user_id, name: str, parent_id):
    parent_filter = (
        NoteFolder.parent_id.is_(None) if parent_id is None else NoteFolder.parent_id == parent_id
    )
    existing = (
        await db.execute(
            select(NoteFolder)
            .where(
                NoteFolder.user_id == user_id,
                NoteFolder.name == name,
                NoteFolder.is_deleted == False,  # noqa: E712
                parent_filter,
            )
            .order_by(NoteFolder.created_at)
            .limit(1)
        )
    ).scalars().first()
    if existing is not None:
        return existing
    return await NoteFolderService.create_folder(
        db, {"name": name, "parent_id": parent_id, "user_id": user_id},
    )


async def _ensure_folder(db, user_id, knowledge_type: str):
    root = await _get_or_create_folder(db, user_id, DISTILL_ROOT_NAME, None)
    return await _get_or_create_folder(db, user_id, KB_DIRS.get(knowledge_type, "topics"), root.id)


async def _knowledge_type(db, note_id) -> str:
    tag = (
        await db.execute(
            select(NoteTag.name)
            .join(NoteNoteTag, NoteNoteTag.tag_id == NoteTag.id)
            .where(NoteNoteTag.note_id == note_id, NoteTag.name.like("kb:%"))
            .limit(1)
        )
    ).scalar_one_or_none()
    return tag.split(":", 1)[1] if tag else "note"


async def main(apply: bool, restore: bool) -> int:
    async with AsyncSessionLocal() as db:
        conditions = [Note.id.in_(select(NoteSource.note_id))]
        conditions.append(Note.is_deleted == restore)
        if not restore:
            conditions.append(Note.folder_id.is_(None))

        notes = (
            await db.execute(
                select(Note.id, Note.created_by, Note.title, Note.folder_id, Note.deleted_at)
                .where(*conditions)
                .order_by(Note.created_at)
            )
        ).all()

        if not notes:
            scope = "回收站里的" if restore else "根目录的"
            print(f"没有需要处理的{scope}蒸馏笔记。")
            return 0

        for note_id, owner_id, title, folder_id, deleted_at in notes:
            knowledge_type = await _knowledge_type(db, note_id)
            directory = KB_DIRS.get(knowledge_type, "topics")
            label = f"{DISTILL_ROOT_NAME}/{directory}"
            if not apply:
                deleted_hint = (
                    f"（删除于 {deleted_at:%Y-%m-%d %H:%M}）" if deleted_at else ""
                )
                tag = "待恢复" if restore else "预演"
                print(f"[{tag}] 《{title}》{deleted_hint} → {label}")
                continue
            note = await db.get(Note, note_id)
            if note is None:
                continue
            if restore:
                note.is_deleted = False
                note.deleted_at = None
            if note.folder_id is None:
                folder = await _ensure_folder(db, owner_id, knowledge_type)
                note.folder_id = folder.id
            await db.commit()
            print(f"[{'已恢复' if restore else '已移动'}] 《{title}》 → {label}")

        if not apply:
            verb = "恢复并移动" if restore else "移动"
            print(f"共 {len(notes)} 篇；加 --apply 执行{verb}。")
        return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="整理蒸馏笔记：移入「蒸馏产出」目录，可选恢复回收站")
    parser.add_argument("--apply", action="store_true", help="实际写入（默认只预演）")
    parser.add_argument("--restore", action="store_true", help="处理回收站中的蒸馏笔记（恢复后再归档）")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.apply, args.restore)))
