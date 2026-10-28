"""网页剪藏：把标题 / 正文 / 来源 URL 落成 Markdown 笔记。"""
from __future__ import annotations

import uuid
from datetime import datetime
from urllib.parse import urlparse

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note, NoteFolder


class ClipService:
    @staticmethod
    async def _resolve_folder_id(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        folder_id: uuid.UUID | None,
        folder_name: str | None,
        create_folder: bool,
    ) -> uuid.UUID | None:
        """按 ID 或名称定位目标文件夹；名称不存在时可按需创建（根级）。"""
        if folder_id is not None:
            folder = await db.get(NoteFolder, folder_id)
            if folder is None or folder.is_deleted or folder.user_id != user_id:
                raise ValueError("目标文件夹不存在或无权访问")
            return folder.id

        name = (folder_name or "").strip()[:200]
        if not name:
            return None

        result = await db.execute(
            select(NoteFolder)
            .where(
                NoteFolder.user_id == user_id,
                NoteFolder.name == name,
                NoteFolder.is_deleted == False,  # noqa: E712
                NoteFolder.parent_id.is_(None),
            )
            .order_by(NoteFolder.created_at)
            .limit(1),
        )
        folder = result.scalar_one_or_none()
        if folder is None and create_folder:
            from app.services.note.note_service import NoteFolderService

            folder = await NoteFolderService.create_folder(db, {
                "name": name,
                "user_id": user_id,
                "parent_id": None,
            })
        return folder.id if folder is not None else None

    @staticmethod
    async def _find_append_target(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        note_id: uuid.UUID | None,
        title: str | None,
    ) -> Note | None:
        """定位可追加的目标笔记：优先 noteId，其次精确标题。"""
        note: Note | None = None
        if note_id is not None:
            note = await db.get(Note, note_id)
        elif title:
            result = await db.execute(
                select(Note)
                .where(
                    Note.created_by == user_id,
                    Note.is_deleted == False,  # noqa: E712
                    func.lower(Note.title) == title.strip().lower(),
                )
                .order_by(Note.updated_at.desc())
                .limit(1),
            )
            note = result.scalar_one_or_none()

        if note is None:
            return None
        if note.created_by != user_id or note.is_deleted:
            raise ValueError("目标笔记不存在或无权访问")
        if note.is_encrypted:
            raise ValueError("加密笔记不支持剪藏追加")
        if note.note_type not in {"markdown", "rich_text"}:
            raise ValueError("只有 Markdown / 富文本笔记支持追加")
        return note

    @staticmethod
    async def _build_section(body: str, url: str | None, heading: str | None = None) -> str:
        date_label = heading or datetime.now().strftime("%Y-%m-%d %H:%M")
        parts = ["---", "", f"## {date_label}", "", body]
        if url:
            parts += ["", f"> 来源：<{url}>"]
        return "\n".join(parts)

    @staticmethod
    async def create_clip(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        text: str,
        title: str | None = None,
        url: str | None = None,
        tags: list[str] | None = None,
        folder_id: uuid.UUID | None = None,
        folder_name: str | None = None,
        create_folder: bool = True,
        mode: str = "new",
        note_id: uuid.UUID | None = None,
        note_title: str | None = None,
    ) -> tuple[Note, str]:
        """创建/追加剪藏，返回 (笔记, 实际模式)。

        - ``new``：每次新建（默认）
        - ``append``：追加到 noteId 或 noteTitle 指定的笔记；不存在则新建
        - ``daily``：追加到当天「每日笔记」
        """
        body = (text or "").strip()
        if not body:
            raise ValueError("剪藏内容不能为空")

        fallback_title = body.split("\n", 1)[0].strip()[:80]
        if not fallback_title and url:
            fallback_title = urlparse(url).hostname or "网页剪藏"
        final_title = (title or fallback_title or "网页剪藏").strip()[:200]
        source_title = (note_title or final_title).strip()[:200]

        from app.services.note.note_service import NoteService

        if mode in {"append", "daily"}:
            if mode == "daily":
                from app.services.note.daily_service import DailyNoteService

                target = await DailyNoteService.ensure_daily_note(db, user_id)
                section = await ClipService._build_section(
                    body, url, heading=datetime.now().strftime("%H:%M"),
                )
                note, error = await NoteService.append_text(
                    db, target.id, user_id, f"\n\n{section}\n",
                )
                if note is None:
                    raise ValueError(error or "追加到每日笔记失败")
                return note, "daily"

            target = await ClipService._find_append_target(
                db, user_id, note_id=note_id, title=note_title or final_title,
            )
            if target is not None:
                section = await ClipService._build_section(body, url)
                note, error = await NoteService.append_text(
                    db, target.id, user_id, f"\n\n{section}\n",
                )
                if note is None:
                    raise ValueError(error or "追加剪藏失败")
                return note, "append"
            # 目标不存在：回落到新建，后续调用即可持续追加

        target_folder_id = await ClipService._resolve_folder_id(
            db,
            user_id,
            folder_id=folder_id,
            folder_name=folder_name,
            create_folder=create_folder,
        )

        parts = [f"# {source_title}", "", body]
        if url:
            parts += ["", f"> 来源：<{url}>"]

        note = await NoteService.create_note(db, {
            "title": source_title,
            "note_type": "markdown",
            "content": {"text": "\n".join(parts)},
            "folder_id": target_folder_id,
            "created_by": user_id,
            "updated_by": user_id,
        })

        if tags:
            from app.services.note.note_enhance_service import NoteTagService

            for name in tags[:5]:
                clean = str(name).strip()[:40]
                if not clean:
                    continue
                existing = {tag.name.lower(): tag for tag in await NoteTagService.list_tags(db, user_id)}
                tag = existing.get(clean.lower())
                if tag is None:
                    tag = await NoteTagService.create_tag(db, user_id, clean)
                await NoteTagService.add_tag_to_note(db, note.id, tag.id, user_id)
        return note, "new"
        return note
