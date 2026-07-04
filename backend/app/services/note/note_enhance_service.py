"""Extended note services: tags, favorites, links, revisions, shares, search."""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.note import (
    Note,
    NoteFavorite,
    NoteLink,
    NoteNoteTag,
    NoteRevision,
    NoteShare,
    NoteTag,
)
from app.services.note.link_parser import build_search_text, extract_wiki_links
from app.services.note.rich_text_blocks import content_to_preview_text


class NoteTagService:
    @staticmethod
    def _base_query():
        return select(NoteTag).where(NoteTag.is_deleted == False)  # noqa: E712

    @staticmethod
    async def list_tags(db: AsyncSession, user_id: UUID) -> list[NoteTag]:
        result = await db.execute(
            NoteTagService._base_query()
            .where(NoteTag.user_id == user_id)
            .order_by(NoteTag.name)
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_tag(db: AsyncSession, tag_id: UUID) -> NoteTag | None:
        result = await db.execute(NoteTagService._base_query().where(NoteTag.id == tag_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def create_tag(db: AsyncSession, user_id: UUID, name: str, color: str = "#6b7280") -> NoteTag:
        tag = NoteTag(user_id=user_id, name=name.strip(), color=color)
        db.add(tag)
        await db.commit()
        return await NoteTagService.get_tag(db, tag.id)  # type: ignore[return-value]

    @staticmethod
    async def update_tag(
        db: AsyncSession, tag_id: UUID, user_id: UUID, data: dict,
    ) -> NoteTag | None:
        tag = await NoteTagService.get_tag(db, tag_id)
        if not tag or tag.user_id != user_id:
            return None
        for k, v in data.items():
            if hasattr(tag, k) and v is not None:
                setattr(tag, k, v)
        await db.commit()
        return await NoteTagService.get_tag(db, tag_id)

    @staticmethod
    async def delete_tag(db: AsyncSession, tag_id: UUID, user_id: UUID) -> bool:
        tag = await NoteTagService.get_tag(db, tag_id)
        if not tag or tag.user_id != user_id:
            return False
        tag.is_deleted = True
        await db.execute(delete(NoteNoteTag).where(NoteNoteTag.tag_id == tag_id))
        await db.commit()
        return True

    @staticmethod
    async def get_tags_for_notes(db: AsyncSession, note_ids: list[UUID]) -> dict[UUID, list[NoteTag]]:
        if not note_ids:
            return {}
        result = await db.execute(
            select(NoteNoteTag.note_id, NoteTag)
            .join(NoteTag, NoteTag.id == NoteNoteTag.tag_id)
            .where(
                NoteNoteTag.note_id.in_(note_ids),
                NoteTag.is_deleted == False,  # noqa: E712
            )
        )
        mapping: dict[UUID, list[NoteTag]] = {nid: [] for nid in note_ids}
        for note_id, tag in result.all():
            mapping[note_id].append(tag)
        return mapping

    @staticmethod
    async def get_note_tags(db: AsyncSession, note_id: UUID) -> list[NoteTag]:
        result = await db.execute(
            select(NoteTag)
            .join(NoteNoteTag, NoteNoteTag.tag_id == NoteTag.id)
            .where(NoteNoteTag.note_id == note_id, NoteTag.is_deleted == False)  # noqa: E712
        )
        return list(result.scalars().all())

    @staticmethod
    async def add_tag_to_note(db: AsyncSession, note_id: UUID, tag_id: UUID, user_id: UUID) -> bool:
        tag = await NoteTagService.get_tag(db, tag_id)
        if not tag or tag.user_id != user_id:
            return False
        existing = await db.execute(
            select(NoteNoteTag).where(NoteNoteTag.note_id == note_id, NoteNoteTag.tag_id == tag_id)
        )
        if existing.scalar_one_or_none():
            return True
        db.add(NoteNoteTag(note_id=note_id, tag_id=tag_id))
        await db.commit()
        return True

    @staticmethod
    async def remove_tag_from_note(db: AsyncSession, note_id: UUID, tag_id: UUID) -> bool:
        result = await db.execute(
            delete(NoteNoteTag).where(NoteNoteTag.note_id == note_id, NoteNoteTag.tag_id == tag_id)
        )
        await db.commit()
        return result.rowcount > 0


class NoteFavoriteService:
    @staticmethod
    async def get_favorited_note_ids(
        db: AsyncSession, user_id: UUID, note_ids: list[UUID],
    ) -> set[UUID]:
        if not note_ids:
            return set()
        result = await db.execute(
            select(NoteFavorite.note_id).where(
                NoteFavorite.user_id == user_id,
                NoteFavorite.note_id.in_(note_ids),
            )
        )
        return set(result.scalars().all())

    @staticmethod
    async def is_favorited(db: AsyncSession, user_id: UUID, note_id: UUID) -> bool:
        result = await db.execute(
            select(NoteFavorite.id).where(
                NoteFavorite.user_id == user_id,
                NoteFavorite.note_id == note_id,
            )
        )
        return result.scalar_one_or_none() is not None

    @staticmethod
    async def add_favorite(db: AsyncSession, user_id: UUID, note_id: UUID) -> bool:
        if await NoteFavoriteService.is_favorited(db, user_id, note_id):
            return True
        db.add(NoteFavorite(user_id=user_id, note_id=note_id))
        await db.commit()
        return True

    @staticmethod
    async def remove_favorite(db: AsyncSession, user_id: UUID, note_id: UUID) -> bool:
        result = await db.execute(
            delete(NoteFavorite).where(
                NoteFavorite.user_id == user_id,
                NoteFavorite.note_id == note_id,
            )
        )
        await db.commit()
        return result.rowcount > 0

    @staticmethod
    async def get_favorited_note_ids(db: AsyncSession, user_id: UUID, note_ids: list[UUID]) -> set[UUID]:
        if not note_ids:
            return set()
        result = await db.execute(
            select(NoteFavorite.note_id).where(
                NoteFavorite.user_id == user_id,
                NoteFavorite.note_id.in_(note_ids),
            )
        )
        return {row[0] for row in result.all()}


class NoteLinkService:
    @staticmethod
    async def sync_links(
        db: AsyncSession,
        source: Note,
        user_id: UUID,
    ) -> None:
        """Re-parse wiki links from content and update note_links table."""
        await db.execute(delete(NoteLink).where(NoteLink.source_id == source.id))
        link_texts = extract_wiki_links(source.content, source.note_type)
        if not link_texts:
            await db.commit()
            return

        for link_text in link_texts:
            target = await NoteLinkService._resolve_target(db, link_text, user_id)
            if target and target.id != source.id:
                db.add(NoteLink(source_id=source.id, target_id=target.id, link_text=link_text))
        await db.commit()

    @staticmethod
    async def _resolve_target(db: AsyncSession, link_text: str, user_id: UUID) -> Note | None:
        stmt = (
            select(Note)
            .where(
                Note.is_deleted == False,  # noqa: E712
                Note.created_by == user_id,
                or_(Note.title == link_text, Note.note_no == link_text),
            )
            .limit(1)
        )
        result = await db.execute(stmt)
        return result.scalar_one_or_none()

    @staticmethod
    async def get_backlinks(db: AsyncSession, note_id: UUID) -> list[dict]:
        result = await db.execute(
            select(NoteLink, Note)
            .join(Note, Note.id == NoteLink.source_id)
            .where(
                NoteLink.target_id == note_id,
                Note.is_deleted == False,  # noqa: E712
            )
            .order_by(NoteLink.created_at.desc())
        )
        items: list[dict] = []
        for link, note in result.all():
            items.append({
                "link_id": str(link.id),
                "source_id": str(note.id),
                "source_title": note.title,
                "source_note_no": note.note_no,
                "link_text": link.link_text,
            })
        return items


class NoteRevisionService:
    @staticmethod
    async def create_revision(
        db: AsyncSession,
        note: Note,
        changed_by: UUID | None,
        change_summary: str | None = None,
    ) -> NoteRevision:
        rev = NoteRevision(
            note_id=note.id,
            title=note.title,
            content_snapshot=note.content,
            description=note.description,
            change_summary=change_summary,
            changed_by=changed_by,
        )
        db.add(rev)
        await db.flush()
        return rev

    @staticmethod
    async def list_revisions(db: AsyncSession, note_id: UUID, limit: int = 50) -> list[NoteRevision]:
        result = await db.execute(
            select(NoteRevision)
            .where(NoteRevision.note_id == note_id)
            .order_by(NoteRevision.created_at.desc())
            .limit(limit)
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_revision(db: AsyncSession, revision_id: UUID) -> NoteRevision | None:
        result = await db.execute(select(NoteRevision).where(NoteRevision.id == revision_id))
        return result.scalar_one_or_none()

    @staticmethod
    async def restore_revision(
        db: AsyncSession,
        note_id: UUID,
        revision_id: UUID,
        user_id: UUID,
    ) -> Note | None:
        from app.services.note.note_service import NoteService

        note = await NoteService.get_note(db, note_id)
        rev = await NoteRevisionService.get_revision(db, revision_id)
        if not note or not rev or rev.note_id != note_id:
            return None
        await NoteRevisionService.create_revision(db, note, user_id, "恢复前快照")
        note.title = rev.title
        note.content = rev.content_snapshot
        note.description = rev.description
        note.updated_by = user_id
        await db.commit()
        if user_id:
            from app.services.note.note_enhance_service import NoteLinkService, NoteSearchService
            refreshed = await NoteService.get_note(db, note_id)
            if refreshed:
                await NoteSearchService.update_search_fields(db, refreshed)
                await NoteLinkService.sync_links(db, refreshed, user_id)
        return await NoteService.get_note(db, note_id)


class NoteShareService:
    @staticmethod
    async def list_shares(db: AsyncSession, note_id: UUID) -> list[NoteShare]:
        result = await db.execute(
            select(NoteShare).where(NoteShare.note_id == note_id).order_by(NoteShare.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def add_share(
        db: AsyncSession,
        note_id: UUID,
        shared_with_user_id: UUID,
        permission: str,
        created_by: UUID,
    ) -> NoteShare:
        existing = await db.execute(
            select(NoteShare).where(
                NoteShare.note_id == note_id,
                NoteShare.shared_with_user_id == shared_with_user_id,
            )
        )
        share = existing.scalar_one_or_none()
        if share:
            share.permission = permission
        else:
            share = NoteShare(
                note_id=note_id,
                shared_with_user_id=shared_with_user_id,
                permission=permission,
                created_by=created_by,
            )
            db.add(share)
        await db.commit()
        await db.refresh(share)
        return share

    @staticmethod
    async def remove_share(db: AsyncSession, note_id: UUID, shared_with_user_id: UUID) -> bool:
        result = await db.execute(
            delete(NoteShare).where(
                NoteShare.note_id == note_id,
                NoteShare.shared_with_user_id == shared_with_user_id,
            )
        )
        await db.commit()
        return result.rowcount > 0

    @staticmethod
    async def user_can_access(db: AsyncSession, note: Note, user_id: UUID) -> bool:
        if not note.created_by or note.created_by == user_id:
            return True
        result = await db.execute(
            select(NoteShare.id).where(
                NoteShare.note_id == note.id,
                NoteShare.shared_with_user_id == user_id,
            )
        )
        return result.scalar_one_or_none() is not None

    @staticmethod
    async def user_can_edit(db: AsyncSession, note: Note, user_id: UUID) -> bool:
        if note.created_by == user_id:
            return True
        result = await db.execute(
            select(NoteShare.permission).where(
                NoteShare.note_id == note.id,
                NoteShare.shared_with_user_id == user_id,
            )
        )
        perm = result.scalar_one_or_none()
        return perm == "edit"


class NoteSearchService:
    @staticmethod
    async def update_search_fields(db: AsyncSession, note: Note) -> None:
        search_text = build_search_text(
            note.title, note.description, note.content, note.note_type,
        )
        note.search_text = search_text or None
        try:
            await db.execute(
                text(
                    "UPDATE note_notes SET search_vector = "
                    "to_tsvector('simple', coalesce(:txt, '')) WHERE id = :id"
                ),
                {"txt": search_text, "id": str(note.id)},
            )
        except Exception:
            pass
        await db.commit()

    @staticmethod
    async def full_text_search(
        db: AsyncSession,
        *,
        user_id: UUID,
        query: str,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[Note], int]:
        pattern = f"%{query}%"
        base_filter = (
            Note.is_deleted == False,  # noqa: E712
            Note.created_by == user_id,
        )
        try:
            ts_query = query.replace("'", " ")
            count_stmt = select(func.count()).select_from(Note).where(
                *base_filter,
                Note.search_vector.op("@@")(func.plainto_tsquery("simple", ts_query)),
            )
            stmt = (
                select(Note)
                .options(selectinload(Note.folder_rel))
                .where(
                    *base_filter,
                    Note.search_vector.op("@@")(func.plainto_tsquery("simple", ts_query)),
                )
                .order_by(Note.updated_at.desc())
                .offset(skip)
                .limit(limit)
            )
            total = (await db.execute(count_stmt)).scalar() or 0
            result = await db.execute(stmt)
            return list(result.scalars().all()), total
        except Exception:
            from sqlalchemy import cast as sa_cast, Text
            content_search = sa_cast(Note.content, Text).ilike(pattern)
            search_filter = (
                Note.title.ilike(pattern)
                | Note.description.ilike(pattern)
                | Note.search_text.ilike(pattern)
                | content_search
            )
            count_stmt = select(func.count()).select_from(Note).where(*base_filter, search_filter)
            stmt = (
                select(Note)
                .options(selectinload(Note.folder_rel))
                .where(*base_filter, search_filter)
                .order_by(Note.updated_at.desc())
                .offset(skip)
                .limit(limit)
            )
            total = (await db.execute(count_stmt)).scalar() or 0
            result = await db.execute(stmt)
            return list(result.scalars().all()), total


def note_preview_text(note: Note, max_len: int = 120) -> str:
    if note.description:
        return note.description[:max_len]
    if note.content:
        text_val = content_to_preview_text(note.note_type, note.content, max_chars=max_len)
        return text_val[:max_len] if text_val else ""
    return ""
