"""匿名账号配额：存储、技能与蒸馏用量。

存储按内容哈希去重统计：同一份文档可能同时被 NoteDocument、KbFile 与
IngestDocument 引用，物理磁盘只占一份，配额也只计一次。
"""
from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.exceptions import BadRequestException, ForbiddenException
from app.models.ai.ai import AISkill
from app.models.kb import KbFile
from app.models.knowledge import IngestDocument, KnowledgeCard
from app.models.note.document import NoteDocument
from app.models.note.note import Note
from app.models.user import User
from app.services.note import document_storage

_MB = 1024 * 1024
_SHA_RE = re.compile(r"([0-9a-f]{64})")


@dataclass
class GuestQuotaSummary:
    storage_used_bytes: int
    storage_limit_bytes: int
    notes_used: int
    max_notes: int
    skills_used: int
    max_skills: int
    daily_distill_limit: int
    daily_distill_used: int
    idle_timeout_minutes: int
    purge_after: datetime | None


def _is_guest(user: User) -> bool:
    return bool(getattr(user, "is_guest", False))


def _sha_from_path(storage_path: str | None) -> str | None:
    if not storage_path:
        return None
    match = _SHA_RE.search(storage_path)
    return match.group(1) if match else None


class GuestQuotaService:
    @staticmethod
    async def storage_usage(db: AsyncSession, user_id: uuid.UUID) -> int:
        """返回匿名用户文档/KB/入库文件占用的去重字节数。"""
        usage: dict[str, int] = {}

        doc_rows = await db.execute(
            select(NoteDocument.sha256, NoteDocument.size_bytes)
            .join(Note, Note.id == NoteDocument.note_id)
            .where(Note.created_by == user_id)
        )
        for sha, size in doc_rows.all():
            if sha:
                usage[sha] = max(usage.get(sha, 0), int(size or 0))

        kb_rows = await db.execute(
            select(KbFile.content_hash, KbFile.size, KbFile.storage_path)
            .where(KbFile.user_id == user_id)
        )
        for content_hash, size, storage_path in kb_rows.all():
            sha = content_hash or _sha_from_path(storage_path)
            if sha:
                usage[sha] = max(usage.get(sha, 0), int(size or 0))

        ingest_rows = await db.execute(
            select(
                IngestDocument.content_hash,
                IngestDocument.raw_meta,
                IngestDocument.storage_path,
            ).where(IngestDocument.user_id == user_id)
        )
        for content_hash, raw_meta, storage_path in ingest_rows.all():
            sha = content_hash or _sha_from_path(storage_path)
            if not sha:
                continue
            meta = raw_meta if isinstance(raw_meta, dict) else {}
            size = int(meta.get("size") or 0)
            if size <= 0 and storage_path:
                path = document_storage.resolve_path(storage_path)
                if path is not None:
                    try:
                        size = path.stat().st_size
                    except OSError:
                        size = 0
            usage[sha] = max(usage.get(sha, 0), size)

        return sum(usage.values())

    @staticmethod
    async def ensure_storage(db: AsyncSession, user: User, incoming_bytes: int) -> None:
        if not _is_guest(user):
            return
        limit = int(get_settings().GUEST_MAX_STORAGE_BYTES or 0)
        if limit <= 0:
            return
        used = await GuestQuotaService.storage_usage(db, user.id)
        incoming = max(0, int(incoming_bytes))
        if used + incoming <= limit:
            return
        raise BadRequestException(
            f"匿名体验存储上限为 {limit // _MB}MB（已用 {used / _MB:.1f}MB，"
            f"本次 {incoming / _MB:.1f}MB）。请删除部分文档或知识库文件，"
            "或登录后继续使用。",
        )

    @staticmethod
    async def ensure_skill_slot(db: AsyncSession, user: User) -> None:
        if not _is_guest(user):
            return
        limit = int(get_settings().GUEST_MAX_SKILLS or 0)
        if limit <= 0:
            return
        used = int(
            await db.scalar(
                select(func.count()).select_from(AISkill).where(
                    AISkill.user_id == user.id,
                    AISkill.is_deleted == False,  # noqa: E712
                ),
            )
            or 0
        )
        if used >= limit:
            raise ForbiddenException(
                f"匿名体验最多创建 {limit} 个自定义技能，"
                "请删除部分技能或登录后继续使用",
            )

    @staticmethod
    async def summary(db: AsyncSession, user: User) -> GuestQuotaSummary:
        env = get_settings()
        notes_used = int(
            await db.scalar(
                select(func.count()).select_from(Note).where(Note.created_by == user.id),
            )
            or 0
        )
        skills_used = int(
            await db.scalar(
                select(func.count()).select_from(AISkill).where(
                    AISkill.user_id == user.id,
                    AISkill.is_deleted == False,  # noqa: E712
                ),
            )
            or 0
        )
        today = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0,
        )
        daily_used = int(
            await db.scalar(
                select(func.count()).select_from(KnowledgeCard).where(
                    KnowledgeCard.user_id == user.id,
                    KnowledgeCard.extractor == "llm",
                    KnowledgeCard.created_at >= today,
                ),
            )
            or 0
        )
        purge_after = (
            user.last_seen_at + timedelta(minutes=env.GUEST_IDLE_TIMEOUT_MINUTES)
            if user.last_seen_at
            else None
        )
        return GuestQuotaSummary(
            storage_used_bytes=await GuestQuotaService.storage_usage(db, user.id),
            storage_limit_bytes=int(env.GUEST_MAX_STORAGE_BYTES),
            notes_used=notes_used,
            max_notes=int(env.GUEST_MAX_NOTES),
            skills_used=skills_used,
            max_skills=int(env.GUEST_MAX_SKILLS),
            daily_distill_limit=int(env.GUEST_KNOWLEDGE_DAILY_LIMIT),
            daily_distill_used=daily_used,
            idle_timeout_minutes=int(env.GUEST_IDLE_TIMEOUT_MINUTES),
            purge_after=purge_after,
        )
