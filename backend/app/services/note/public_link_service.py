"""公开只读分享链接：创建 / 撤销 / 按 token 读取。"""
from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note, NotePublicLink


class NotePublicLinkService:
    @staticmethod
    async def get_active(db: AsyncSession, note_id: uuid.UUID) -> NotePublicLink | None:
        result = await db.execute(
            select(NotePublicLink)
            .where(NotePublicLink.note_id == note_id)
            .order_by(NotePublicLink.created_at.desc())
            .limit(1),
        )
        link = result.scalar_one_or_none()
        if link is None:
            return None
        if link.expires_at is not None:
            expires = link.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires <= datetime.now(timezone.utc):
                return None
        return link

    @staticmethod
    async def create_or_get(
        db: AsyncSession, note: Note, user_id: uuid.UUID,
    ) -> NotePublicLink:
        existing = await NotePublicLinkService.get_active(db, note.id)
        if existing is not None:
            return existing
        link = NotePublicLink(
            note_id=note.id,
            created_by=user_id,
            token=secrets.token_urlsafe(24),
        )
        db.add(link)
        await db.commit()
        await db.refresh(link)
        return link

    @staticmethod
    async def revoke(db: AsyncSession, note_id: uuid.UUID) -> int:
        result = await db.execute(
            select(NotePublicLink).where(NotePublicLink.note_id == note_id),
        )
        links = list(result.scalars().all())
        for link in links:
            await db.delete(link)
        await db.commit()
        return len(links)

    @staticmethod
    async def resolve(db: AsyncSession, token: str) -> Note | None:
        result = await db.execute(
            select(NotePublicLink).where(NotePublicLink.token == token),
        )
        link = result.scalar_one_or_none()
        if link is None:
            return None
        if link.expires_at is not None:
            expires = link.expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires <= datetime.now(timezone.utc):
                return None
        note = await db.get(Note, link.note_id)
        if note is None or note.is_deleted or note.is_encrypted:
            return None
        return note
