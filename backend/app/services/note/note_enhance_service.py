"""Extended note services: tags, favorites, links, revisions, shares, search."""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from html import escape
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
from app.config import get_settings
from app.services.note.link_parser import build_search_text, extract_wiki_links
from app.services.note.rich_text_blocks import content_to_preview_text
from app.services.note.search_config import (
    SearchConfigService,
    SearchStrategy,
    contains_cjk,
    latin_tokens,
)

logger = logging.getLogger(__name__)


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
        *,
        pinned: bool = False,
    ) -> NoteRevision:
        # 分配单调递增 seq：同秒创建的修订 created_at 相同，必须靠它区分「先后」。
        result = await db.execute(
            select(func.coalesce(func.max(NoteRevision.seq), 0) + 1).where(
                NoteRevision.note_id == note.id,
            )
        )
        next_seq = int(result.scalar() or 1)

        rev = NoteRevision(
            note_id=note.id,
            seq=next_seq,
            title=note.title,
            content_snapshot=note.content,
            description=note.description,
            change_summary=change_summary,
            is_pinned=pinned,
            changed_by=changed_by,
        )
        db.add(rev)
        await db.flush()
        return rev

    @staticmethod
    async def prune_revisions(
        db: AsyncSession,
        note_id: UUID,
        *,
        keep: int | None = None,
    ) -> int:
        """淘汰超出保留上限的旧修订，返回删除条数。

        仅淘汰 ``is_pinned=False`` 的记录（「恢复前快照」等关键节点永久保留），
        保留 seq 最大的 ``keep`` 条未置位修订。删除走一条 SQL 定位 IN 子集，
        避免把整条修订历史读进内存。
        """
        limit = keep if keep is not None else get_settings().NOTE_REVISION_KEEP
        if limit <= 0:
            return 0
        stmt = (
            delete(NoteRevision)
            .where(
                NoteRevision.note_id == note_id,
                NoteRevision.is_pinned == False,  # noqa: E712
                NoteRevision.id.notin_(
                    select(NoteRevision.id)
                    .where(
                        NoteRevision.note_id == note_id,
                        NoteRevision.is_pinned == False,  # noqa: E712
                    )
                    .order_by(NoteRevision.seq.desc())
                    .limit(limit)
                ),
            )
        )
        result = await db.execute(stmt)
        return int(result.rowcount or 0)

    @staticmethod
    async def list_revisions(db: AsyncSession, note_id: UUID, limit: int = 50) -> list[NoteRevision]:
        return await NoteRevisionService.list_revisions_page(db, note_id, limit=limit)

    @staticmethod
    async def list_revisions_page(
        db: AsyncSession, note_id: UUID, *, limit: int = 50,
    ) -> list[NoteRevision]:
        result = await db.execute(
            select(NoteRevision)
            .where(NoteRevision.note_id == note_id)
            .order_by(NoteRevision.seq.desc())
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
        await NoteRevisionService.create_revision(
            db, note, user_id, "恢复前快照", pinned=True,
        )
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
                from app.services.ai.embedding_service import schedule_note_embedding
                schedule_note_embedding(note_id)
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
    async def _document_text(db: AsyncSession, note: Note) -> str | None:
        """文档笔记的正文在附表中；只取该列，避免加载整行元数据。"""
        if note.note_type != "document":
            return None
        from app.models.note.document import NoteDocument

        result = await db.execute(
            select(NoteDocument.extracted_text).where(NoteDocument.note_id == note.id),
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def update_search_fields(db: AsyncSession, note: Note) -> None:
        """重建检索字段：search_text + search_vector。

        分词配置与查询侧保持一致（见 search_config），否则写入用A、查询用B
        会让匹配结果悄悄为空。TSVECTOR 写入失败不再静默吞掉，改为告警，
        便于发现「检索索引已失效」这类静默故障。
        """
        search_text = build_search_text(
            note.title, note.description, note.content, note.note_type,
            document_text=await NoteSearchService._document_text(db, note),
        )
        note.search_text = search_text or None
        if not search_text:
            await db.execute(
                text("UPDATE note_notes SET search_vector = NULL WHERE id = :id"),
                {"id": str(note.id)},
            )
            await db.commit()
            return

        strategy = await SearchConfigService.resolve(db)
        ts_config = SearchConfigService.tsquery_config(strategy)
        # 测试用 SQLite 没有 to_tsvector；跳过向量字段，search_text 仍可做模糊匹配
        bind = db.get_bind()
        if bind is not None and bind.dialect.name != "postgresql":
            await db.commit()
            return
        try:
            # 用 SAVEPOINT 隔离：SQLite / 未装 zhparser 的库会因缺函数报错，
            # 必须在子事务里吞掉，否则整个请求的事务会被标记为失败。
            async with db.begin_nested():
                await db.execute(
                    text(
                        f"UPDATE note_notes SET search_vector = "  # noqa: S608 — 配置名来自白名单枚举
                        f"to_tsvector('{ts_config}', coalesce(:txt, '')) WHERE id = :id"
                    ),
                    {"txt": search_text, "id": str(note.id)},
                )
        except Exception:
            logger.warning(
                "写入 search_vector 失败（配置=%s），该笔记将只走模糊匹配：note=%s",
                ts_config, note.id, exc_info=True,
            )
        await db.commit()

    @staticmethod
    async def full_text_search(
        db: AsyncSession,
        *,
        user_id: UUID,
        query: str,
        skip: int = 0,
        limit: int = 50,
        include_shared: bool = False,
    ) -> tuple[list[Note], int]:
        """全文检索：按可用方案走 zhparser / pg_trgm / ILIKE 三级降级。

        ``include_shared`` 为真时把共享给当前用户的笔记一并纳入，权限以
        ``NoteShare`` 记录为准（只有显式分享过的笔记可见）。
        """
        if not query or not query.strip():
            return [], 0

        pattern = f"%{query.strip()}%"
        ownership = Note.created_by == user_id
        if include_shared:
            shared_note_ids = select(NoteShare.note_id).where(
                NoteShare.shared_with_user_id == user_id,
            )
            ownership = or_(ownership, Note.id.in_(shared_note_ids))
        base_filter = (
            Note.is_deleted == False,  # noqa: E712
            ownership,
        )
        strategy = await SearchConfigService.resolve(db)

        if strategy == SearchStrategy.ZHPARSER:
            result = await NoteSearchService._search_tsvector(
                db, base_filter, query, skip, limit, "zhparser",
            )
            if result is not None:
                return result

        if strategy == SearchStrategy.TRIGRAM and contains_cjk(query):
            result = await NoteSearchService._search_trigram(
                db, base_filter, query, pattern, skip, limit,
            )
            if result is not None:
                return result

        # 英文/数字查询：即便库是中文分词，也交给 TSVECTOR 处理精度更高
        tokens = latin_tokens(query)
        ts_config = SearchConfigService.tsquery_config(strategy)
        if tokens:
            result = await NoteSearchService._search_tsvector(
                db, base_filter, " ".join(tokens), skip, limit, ts_config,
            )
            if result is not None:
                return result

        result = await NoteSearchService._search_ilike(db, base_filter, query, pattern, skip, limit)
        if result[1]:
            return result

        # 自然语言长问句（"XX 包含哪些内容？"）在 trigram / ILIKE 下容易整句失配：
        # 退化为"问句开头若干字"的标题/正文前缀匹配，显著提升问答召回。
        compact = query.strip()
        for length in (12, 8, 6, 4):
            prefix = compact[:length]
            if len(prefix) < 4 or prefix == compact:
                continue
            prefix_result = await NoteSearchService._search_ilike(
                db, base_filter, prefix, f"%{prefix}%", skip, limit,
            )
            if prefix_result[1]:
                return prefix_result
        return result

    @staticmethod
    async def _search_tsvector(
        db: AsyncSession,
        base_filter: tuple,
        query: str,
        skip: int,
        limit: int,
        ts_config: str,
    ) -> tuple[list[Note], int] | None:
        """TSVECTOR 检索；不可用时返回 None 以便降级。"""
        ts_query = query.replace("'", " ")
        match = Note.search_vector.op("@@")(func.plainto_tsquery(ts_config, ts_query))
        try:
            async with db.begin_nested():
                count_stmt = select(func.count()).select_from(Note).where(*base_filter, match)
                stmt = (
                    select(Note)
                    .options(selectinload(Note.folder_rel))
                    .where(*base_filter, match)
                    .order_by(
                        func.ts_rank(
                            Note.search_vector, func.plainto_tsquery(ts_config, ts_query),
                        ).desc(),
                        Note.updated_at.desc(),
                    )
                    .offset(skip)
                    .limit(limit)
                )
                total = (await db.execute(count_stmt)).scalar() or 0
                result = await db.execute(stmt)
                items = list(result.scalars().all())
            return items, int(total)
        except Exception:
            logger.warning(
                "TSVECTOR 检索失败（配置=%s），降级到模糊匹配", ts_config, exc_info=True,
            )
            return None

    @staticmethod
    async def _search_trigram(
        db: AsyncSession,
        base_filter: tuple,
        query: str,
        pattern: str,
        skip: int,
        limit: int,
    ) -> tuple[list[Note], int] | None:
        """pg_trgm 三元组相似度检索（中文友好），不可用时返回 None。"""
        threshold = SearchConfigService.similarity_threshold()
        try:
            similarity = func.similarity(Note.title, query)
            sim_content = func.similarity(Note.search_text, query)
            score = func.greatest(similarity, sim_content)

            match = func.greatest(
                func.similarity(Note.title, query),
                func.similarity(Note.search_text, query),
            ) >= threshold
            match = match | Note.title.ilike(pattern)

            count_stmt = select(func.count()).select_from(Note).where(*base_filter, match)
            stmt = (
                select(Note)
                .options(selectinload(Note.folder_rel))
                .where(*base_filter, match)
                .order_by(score.desc())
                .order_by(Note.updated_at.desc())
                .offset(skip)
                .limit(limit)
            )
            total = (await db.execute(count_stmt)).scalar() or 0
            result = await db.execute(stmt)
            return list(result.scalars().all()), int(total)
        except Exception:
            logger.warning("pg_trgm 检索失败，降级到模糊匹配", exc_info=True)
            return None

    @staticmethod
    async def _search_ilike(
        db: AsyncSession,
        base_filter: tuple,
        query: str,
        pattern: str,
        skip: int,
        limit: int,
    ) -> tuple[list[Note], int]:
        """最后的兜底：标题 / 描述 / 检索文本模糊匹配。"""
        search_filter = (
            Note.title.ilike(pattern)
            | Note.description.ilike(pattern)
            | Note.search_text.ilike(pattern)
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
        return list(result.scalars().all()), int(total)


def note_preview_text(note: Note, max_len: int = 120) -> str:
    if note.description:
        return note.description[:max_len]
    if note.note_type == "document":
        # 正文在附表中，列表接口不加载；search_text 已含正文，取开头即可。
        return (note.search_text or "")[:max_len]
    if note.content:
        text_val = content_to_preview_text(note.note_type, note.content, max_chars=max_len)
        return text_val[:max_len] if text_val else ""
    return ""


def highlight_snippet(text: str, query: str, max_len: int = 200) -> str:
    """返回命中词附近的片段，并用 ``<mark>`` 包裹命中文本。

    输出会直接进前端搜索结果，因此**先做 HTML 转义再插标记**，笔记正文里的
    尖括号/脚本不会被当成 HTML 执行。
    """
    flat = " ".join((text or "").split())
    needle = (query or "").strip()
    if not flat:
        return ""
    if not needle:
        return escape(flat[:max_len])

    lower = flat.lower()
    idx = lower.find(needle.lower())
    if idx < 0:
        return escape(flat[:max_len])

    start = max(0, idx - max_len // 3)
    end = min(len(flat), start + max_len)
    snippet = escape(flat[start:end])
    escaped_needle = escape(needle)
    marked = re.sub(
        re.escape(escaped_needle),
        lambda m: f"<mark>{m.group(0)}</mark>",
        snippet,
        flags=re.IGNORECASE,
    )
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(flat) else ""
    return f"{prefix}{marked}{suffix}"
