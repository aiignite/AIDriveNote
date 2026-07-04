"""Note Service – business logic for notes."""
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.note import Note, NoteFavorite, NoteFolder, NoteNoteTag, NoteTemplate


class NoteFolderService:
    """Data-access layer for note folders."""

    @staticmethod
    def _base_query():
        return select(NoteFolder).options(
            selectinload(NoteFolder.notes),
            selectinload(NoteFolder.children),
        ).where(NoteFolder.is_deleted == False)  # noqa: E712

    @staticmethod
    async def list_folders(db: AsyncSession, user_id: UUID) -> list[NoteFolder]:
        result = await db.execute(
            NoteFolderService._base_query()
            .where(NoteFolder.user_id == user_id)
            .order_by(NoteFolder.sort_order, NoteFolder.created_at)
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_folder(db: AsyncSession, folder_id: UUID) -> NoteFolder | None:
        result = await db.execute(
            NoteFolderService._base_query().where(NoteFolder.id == folder_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def create_folder(db: AsyncSession, data: dict) -> NoteFolder:
        folder = NoteFolder(**data)
        db.add(folder)
        await db.commit()
        return await NoteFolderService.get_folder(db, folder.id)

    @staticmethod
    async def update_folder(db: AsyncSession, folder_id: UUID, data: dict) -> NoteFolder | None:
        folder = await NoteFolderService.get_folder(db, folder_id)
        if not folder:
            return None
        for k, v in data.items():
            if hasattr(folder, k):
                setattr(folder, k, v)
        await db.commit()
        return await NoteFolderService.get_folder(db, folder_id)

    @staticmethod
    async def delete_folder(db: AsyncSession, folder_id: UUID) -> bool:
        folder = await NoteFolderService.get_folder(db, folder_id)
        if not folder:
            return False
        # Move notes in this folder (and descendants) to root
        folder_ids = await NoteFolderService._collect_descendant_folder_ids(db, folder_id)
        folder_ids.add(folder_id)
        notes_result = await db.execute(
            select(Note).where(
                Note.folder_id.in_(folder_ids),
                Note.is_deleted == False,  # noqa: E712
            )
        )
        for note in notes_result.scalars().all():
            note.folder_id = None
        folders_result = await db.execute(
            select(NoteFolder).where(NoteFolder.id.in_(folder_ids))
        )
        for child_folder in folders_result.scalars().all():
            child_folder.is_deleted = True
        await db.commit()
        return True

    @staticmethod
    async def _collect_descendant_folder_ids(db: AsyncSession, folder_id: UUID) -> set[UUID]:
        """Collect all non-deleted descendant folder IDs."""
        result = await db.execute(
            NoteFolderService._base_query().where(NoteFolder.parent_id == folder_id)
        )
        child_ids: set[UUID] = set()
        for child in result.scalars().all():
            child_ids.add(child.id)
            child_ids.update(await NoteFolderService._collect_descendant_folder_ids(db, child.id))
        return child_ids


class NoteService:
    """Data-access layer for note management."""

    @staticmethod
    async def _next_note_no(db: AsyncSession, year: int | None = None) -> str:
        y = year or datetime.now().year
        prefix = f"NT{y}"
        result = await db.execute(
            select(func.max(Note.note_no)).where(Note.note_no.like(f"{prefix}%"))
        )
        max_no = result.scalar()
        seq = int(max_no[-6:]) + 1 if max_no else 1
        return f"{prefix}{seq:06d}"

    @staticmethod
    def _base_query():
        """Return base query with soft-delete filter."""
        return select(Note).options(
            selectinload(Note.folder_rel),
        ).where(Note.is_deleted == False)  # noqa: E712

    @staticmethod
    async def get_note_any(db: AsyncSession, note_id: UUID) -> Note | None:
        """Get note including soft-deleted records."""
        result = await db.execute(
            select(Note)
            .options(selectinload(Note.folder_rel))
            .where(Note.id == note_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def list_trash_notes(
        db: AsyncSession,
        *,
        user_id: UUID,
        skip: int = 0,
        limit: int = 100,
        search: str | None = None,
    ) -> tuple[list[Note], int]:
        stmt = (
            select(Note)
            .options(selectinload(Note.folder_rel))
            .where(Note.is_deleted == True, Note.created_by == user_id)  # noqa: E712
        )
        count_stmt = select(func.count()).select_from(Note).where(
            Note.is_deleted == True,  # noqa: E712
            Note.created_by == user_id,
        )
        if search:
            pattern = f"%{search}%"
            from sqlalchemy import cast as sa_cast, Text
            content_search = sa_cast(Note.content, Text).ilike(pattern)
            search_filter = (
                Note.title.ilike(pattern) | Note.description.ilike(pattern) | content_search
            )
            stmt = stmt.where(search_filter)
            count_stmt = count_stmt.where(search_filter)

        stmt = stmt.order_by(
            Note.deleted_at.desc().nulls_last(),
            Note.updated_at.desc(),
        ).offset(skip).limit(limit)
        total = (await db.execute(count_stmt)).scalar() or 0
        result = await db.execute(stmt)
        return list(result.scalars().all()), total

    @staticmethod
    async def get_note(db: AsyncSession, note_id: UUID) -> Note | None:
        result = await db.execute(
            NoteService._base_query().where(Note.id == note_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def list_notes(
        db: AsyncSession,
        *,
        skip: int = 0,
        limit: int = 100,
        search: str | None = None,
        note_type: str | None = None,
        folder_id: UUID | None = None,
        user_id: UUID | None = None,
        status: str | None = None,
        is_pinned: bool | None = None,
        is_favorite: bool | None = None,
        tag_ids: list[UUID] | None = None,
        include_shared: bool = False,
    ) -> tuple[list[Note], int]:
        stmt = NoteService._base_query()
        count_stmt = select(func.count()).select_from(Note).where(Note.is_deleted == False)  # noqa: E712

        if user_id:
            if include_shared:
                from app.models.note import NoteShare
                shared_subq = select(NoteShare.note_id).where(NoteShare.shared_with_user_id == user_id)
                owner_filter = or_(Note.created_by == user_id, Note.id.in_(shared_subq))
                stmt = stmt.where(owner_filter)
                count_stmt = count_stmt.where(owner_filter)
            else:
                stmt = stmt.where(Note.created_by == user_id)
                count_stmt = count_stmt.where(Note.created_by == user_id)
        if note_type:
            stmt = stmt.where(Note.note_type == note_type)
            count_stmt = count_stmt.where(Note.note_type == note_type)
        if folder_id:
            stmt = stmt.where(Note.folder_id == folder_id)
            count_stmt = count_stmt.where(Note.folder_id == folder_id)
        if status:
            stmt = stmt.where(Note.status == status)
            count_stmt = count_stmt.where(Note.status == status)
        if is_pinned is not None:
            stmt = stmt.where(Note.is_pinned == is_pinned)
            count_stmt = count_stmt.where(Note.is_pinned == is_pinned)
        if is_favorite and user_id:
            stmt = stmt.join(NoteFavorite, NoteFavorite.note_id == Note.id).where(
                NoteFavorite.user_id == user_id,
            )
            count_stmt = count_stmt.join(NoteFavorite, NoteFavorite.note_id == Note.id).where(
                NoteFavorite.user_id == user_id,
            )
        if tag_ids:
            for tag_id in tag_ids:
                stmt = stmt.join(
                    NoteNoteTag,
                    NoteNoteTag.note_id == Note.id,
                ).where(NoteNoteTag.tag_id == tag_id)
                count_stmt = count_stmt.join(
                    NoteNoteTag,
                    NoteNoteTag.note_id == Note.id,
                ).where(NoteNoteTag.tag_id == tag_id)
        if search:
            pattern = f"%{search}%"
            from sqlalchemy import cast as sa_cast, Text
            content_search = sa_cast(Note.content, Text).ilike(pattern)
            search_filter = (
                Note.title.ilike(pattern)
                | Note.description.ilike(pattern)
                | Note.search_text.ilike(pattern)
                | content_search
            )
            stmt = stmt.where(search_filter)
            count_stmt = count_stmt.where(search_filter)

        stmt = stmt.order_by(Note.is_pinned.desc(), Note.updated_at.desc()).offset(skip).limit(limit)
        total = (await db.execute(count_stmt)).scalar() or 0
        result = await db.execute(stmt)
        return list(result.scalars().all()), total

    @staticmethod
    async def create_note(db: AsyncSession, data: dict) -> Note:
        if not data.get("note_no"):
            data["note_no"] = await NoteService._next_note_no(db)
        note = Note(**data)
        db.add(note)
        await db.commit()
        note_id = note.id
        if note_id:
            from app.services.note.note_enhance_service import NoteLinkService, NoteSearchService
            refreshed = await NoteService.get_note(db, note_id)
            if refreshed:
                await NoteSearchService.update_search_fields(db, refreshed)
                user_id = refreshed.created_by
                if user_id:
                    await NoteLinkService.sync_links(db, refreshed, user_id)
        return await NoteService.get_note(db, note_id)

    @staticmethod
    async def update_note(
        db: AsyncSession,
        note_id: UUID,
        data: dict,
        *,
        save_revision: bool = True,
        change_summary: str | None = None,
    ) -> Note | None:
        note = await NoteService.get_note(db, note_id)
        if not note:
            return None
        content_changed = "content" in data and data["content"] != note.content
        title_changed = "title" in data and data["title"] != note.title
        if save_revision and (content_changed or title_changed):
            from app.services.note.note_enhance_service import NoteRevisionService
            changed_by = data.get("updated_by")
            await NoteRevisionService.create_revision(
                db, note, changed_by, change_summary or "内容更新",
            )
        for k, v in data.items():
            if hasattr(note, k):
                setattr(note, k, v)
        await db.commit()
        if content_changed or title_changed or "description" in data:
            from app.services.note.note_enhance_service import NoteLinkService, NoteSearchService
            refreshed = await NoteService.get_note(db, note_id)
            if refreshed:
                await NoteSearchService.update_search_fields(db, refreshed)
                user_id = refreshed.created_by or data.get("updated_by")
                if user_id and content_changed:
                    await NoteLinkService.sync_links(db, refreshed, user_id)
        return await NoteService.get_note(db, note_id)

    @staticmethod
    async def delete_note(db: AsyncSession, note_id: UUID) -> bool:
        note = await NoteService.get_note(db, note_id)
        if not note:
            return False
        note.is_deleted = True
        note.deleted_at = datetime.now(timezone.utc)
        await db.commit()
        return True

    @staticmethod
    async def restore_note(db: AsyncSession, note_id: UUID) -> Note | None:
        note = await NoteService.get_note_any(db, note_id)
        if not note or not note.is_deleted:
            return None
        note.is_deleted = False
        note.deleted_at = None
        await db.commit()
        return await NoteService.get_note(db, note_id)

    @staticmethod
    async def permanently_delete_note(db: AsyncSession, note_id: UUID) -> bool:
        note = await NoteService.get_note_any(db, note_id)
        if not note or not note.is_deleted:
            return False
        await db.delete(note)
        await db.commit()
        return True

    @staticmethod
    async def duplicate_note(db: AsyncSession, note_id: UUID, user_id: UUID) -> Note | None:
        original = await NoteService.get_note(db, note_id)
        if not original:
            return None
        return await NoteService.create_note(db, {
            "title": f"{original.title} - 副本",
            "note_type": original.note_type,
            "content": original.content,
            "description": original.description,
            "status": original.status,
            "folder_id": original.folder_id,
            "created_by": user_id,
            "updated_by": user_id,
        })


class NoteTemplateService:
    """Data-access layer for note templates."""

    @staticmethod
    def _base_query():
        return select(NoteTemplate).where(NoteTemplate.is_deleted == False)  # noqa: E712

    @staticmethod
    async def list_templates(
        db: AsyncSession,
        *,
        note_type: str | None = None,
        search: str | None = None,
    ) -> list[NoteTemplate]:
        stmt = NoteTemplateService._base_query()
        if note_type:
            stmt = stmt.where(NoteTemplate.note_type == note_type)
        if search:
            stmt = stmt.where(NoteTemplate.name.ilike(f"%{search}%"))
        stmt = stmt.order_by(NoteTemplate.sort_order, NoteTemplate.created_at.desc())
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_template(db: AsyncSession, template_id: UUID) -> NoteTemplate | None:
        result = await db.execute(
            NoteTemplateService._base_query().where(NoteTemplate.id == template_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def create_template(db: AsyncSession, data: dict) -> NoteTemplate:
        tpl = NoteTemplate(**data)
        db.add(tpl)
        await db.commit()
        return await NoteTemplateService.get_template(db, tpl.id)

    @staticmethod
    async def update_template(db: AsyncSession, template_id: UUID, data: dict) -> NoteTemplate | None:
        tpl = await NoteTemplateService.get_template(db, template_id)
        if not tpl:
            return None
        for k, v in data.items():
            if hasattr(tpl, k):
                setattr(tpl, k, v)
        await db.commit()
        return await NoteTemplateService.get_template(db, template_id)

    @staticmethod
    async def delete_template(db: AsyncSession, template_id: UUID) -> bool:
        tpl = await NoteTemplateService.get_template(db, template_id)
        if not tpl:
            return False
        tpl.is_deleted = True
        await db.commit()
        return True

    @staticmethod
    async def create_note_from_template(
        db: AsyncSession, template_id: UUID, user_id: UUID,
        folder_id: UUID | None = None, title: str | None = None,
    ) -> Note | None:
        """根据模板创建笔记。"""
        tpl = await NoteTemplateService.get_template(db, template_id)
        if not tpl:
            return None
        note_data = {
            "title": title or f"{tpl.name}",
            "note_type": tpl.note_type,
            "content": tpl.content,
            "description": tpl.description,
            "folder_id": folder_id,
            "created_by": user_id,
            "updated_by": user_id,
        }
        return await NoteService.create_note(db, note_data)
