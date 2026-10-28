"""Note Service – business logic for notes."""
import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import get_settings
from app.exceptions import BadRequestException
from app.models.note import Note, NoteFavorite, NoteFolder, NoteNoteTag, NoteTemplate
from app.models.user import User
from app.services.note.rich_text_blocks import merge_rich_text_blocks

logger = logging.getLogger(__name__)


class NoteFolderService:
    """Data-access layer for note folders."""

    @staticmethod
    def _base_query():
        return select(NoteFolder).options(
            selectinload(NoteFolder.children),
        ).where(NoteFolder.is_deleted == False)  # noqa: E712

    @staticmethod
    async def list_folders(db: AsyncSession, user_id: UUID) -> list[NoteFolder]:
        # 仅返回文件夹元数据；前端自行用 parent_id 组树，无需预加载笔记
        result = await db.execute(
            select(NoteFolder)
            .where(
                NoteFolder.is_deleted == False,  # noqa: E712
                NoteFolder.user_id == user_id,
            )
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
        """生成下一个笔记编号。

        历史实现是 ``SELECT MAX(note_no) + 1``，并发创建会拿到**相同编号**并撞
        唯一约束。这里改为调用数据库函数 ``app_next_note_no(year)``——它内部用
        ``pg_advisory_xact_lock`` 把「查最大值 + 占号」串行化。

        数据库未安装该函数时（本地 SQLite / 未执行迁移）退回到原先的
        MAX+1 逻辑，保证开发与测试环境可用。
        """
        y = year or datetime.now().year
        try:
            result = await db.execute(text("SELECT app_next_note_no(:y)"), {"y": y})
            return str(result.scalar())
        except Exception:
            logger.debug("app_next_note_no 不可用，退回 MAX+1", exc_info=True)

        prefix = f"NT{y}"
        result = await db.execute(
            select(func.max(Note.note_no)).where(Note.note_no.like(f"{prefix}%"))
        )
        max_no = result.scalar()
        digits = max_no[len(prefix):] if max_no and max_no.startswith(prefix) else ""
        seq = (int(digits) + 1) if digits.isdigit() else 1
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
    async def _resolve_max_notes(db: AsyncSession, owner_id) -> int:
        """取该用户的笔记数量上限。

        匿名账号走更低的 ``GUEST_MAX_NOTES``：其数据到期即被清除，
        但在存活期间仍占用服务端存储与 AI 索引资源，不应与正式账号同配额。
        """
        settings = get_settings()
        if not owner_id:
            return settings.USER_MAX_NOTES
        try:
            result = await db.execute(
                select(User.is_guest).where(User.id == owner_id)
            )
            is_guest = result.scalar_one_or_none()
        except Exception:  # noqa: BLE001 — 查询失败时按普通用户处理，不阻断建笔记
            is_guest = None
        if is_guest:
            guest_max = settings.GUEST_MAX_NOTES
            return guest_max if guest_max > 0 else settings.USER_MAX_NOTES
        return settings.USER_MAX_NOTES

    @staticmethod
    async def create_note(db: AsyncSession, data: dict) -> Note:
        """创建笔记。

        编号由 ``_next_note_no`` 生成；极端并发下（数据库函数不可用且退回
        MAX+1）仍可能撞唯一约束，这里捕获后重试数次，避免 500 直接失败。

        单用户笔记总量含回收站：所有创建路径（路由 / 复制 / 模板 / AI 工具 / MCP）
        都汇聚到这里，超限一律拒绝。正式用户按 ``USER_MAX_NOTES``，匿名用户按更低的
        ``GUEST_MAX_NOTES``（见 :meth:`_resolve_max_notes`）。
        """
        owner_id = data.get("created_by")
        max_notes = await NoteService._resolve_max_notes(db, owner_id)
        if max_notes > 0 and owner_id:
            total = (
                await db.execute(
                    select(func.count()).select_from(Note).where(Note.created_by == owner_id)
                )
            ).scalar() or 0
            if total >= max_notes:
                raise BadRequestException(
                    f"笔记数量已达上限（{max_notes} 篇，含回收站），请先删除或清理部分笔记",
                )

        from app.services.note.note_enhance_service import NoteLinkService, NoteSearchService

        last_error: IntegrityError | None = None
        for attempt in range(3):
            payload = dict(data)
            if not payload.get("note_no"):
                payload["note_no"] = await NoteService._next_note_no(db)
            try:
                note = Note(**payload)
                db.add(note)
                await db.commit()
            except IntegrityError as exc:  # 编号冲突 → 回滚后重试
                await db.rollback()
                last_error = exc
                logger.warning("创建笔记编号冲突，第 %s 次重试", attempt + 1)
                continue
            break
        else:
            raise last_error  # type: ignore[misc]

        note_id = note.id
        if note_id:
            refreshed = await NoteService.get_note(db, note_id)
            if refreshed:
                await NoteSearchService.update_search_fields(db, refreshed)
                user_id = refreshed.created_by
                if user_id:
                    await NoteLinkService.sync_links(db, refreshed, user_id)
                # 新建笔记也要进语义索引，否则导入/模板创建的笔记永远搜不到
                from app.services.ai.embedding_service import schedule_note_embedding
                schedule_note_embedding(note_id)
        return await NoteService.get_note(db, note_id)

    @staticmethod
    async def update_note(
        db: AsyncSession,
        note_id: UUID,
        data: dict,
        *,
        save_revision: bool = True,
        change_summary: str | None = None,
        skip_derived: bool = False,
    ) -> Note | None:
        note = await NoteService.get_note(db, note_id)
        if not note:
            return None
        content_changed = "content" in data and data["content"] != note.content
        title_changed = "title" in data and data["title"] != note.title

        # 加密笔记：跳过一切会把明文写往别处的衍生流程（修订快照 / 检索 / 链接 / embedding）
        if skip_derived:
            for k, v in data.items():
                if hasattr(note, k):
                    setattr(note, k, v)
            await db.commit()
            return await NoteService.get_note(db, note_id)

        # 标题自动填充：仅当本次带回了新内容、且标题仍是占位值时才推导。
        # 用户手动起过的名字绝不覆盖（见 title_derive.should_autofill_title）。
        autofilled_title = ""
        if content_changed and data.get("content") is not None:
            from app.services.note.title_derive import should_autofill_title
            autofilled_title = should_autofill_title(
                note.title,
                note.note_type,
                data["content"],
            )
            if autofilled_title and autofilled_title != note.title:
                data = {**data, "title": autofilled_title}
                title_changed = True

        if save_revision and (content_changed or title_changed):
            from app.services.note.note_enhance_service import NoteRevisionService
            changed_by = data.get("updated_by")
            await NoteRevisionService.create_revision(
                db, note, changed_by, change_summary or "内容更新",
            )
            # 修订表容量治理：只保留最近 N 条，避免长寿命笔记的历史无限增长
            await NoteRevisionService.prune_revisions(db, note.id)
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
                # 向量重建放到后台：保存不再被 Ollama 的 30s 超时拖住，
                # 失败也会在日志里可见，而不是被静默吞掉。
                from app.services.ai.embedding_service import schedule_note_embedding
                schedule_note_embedding(note_id)
        return await NoteService.get_note(db, note_id)

    @staticmethod
    async def append_text(
        db: AsyncSession,
        note_id: UUID,
        user_id: UUID,
        text: str,
    ) -> tuple[Note | None, str | None]:
        """向笔记末尾追加文本。

        仅支持 markdown / rich_text 两种类型：
        - markdown：读取 content["text"] 后以空行拼接
        - rich_text：复用 merge_rich_text_blocks 追加为新的块

        写回统一走 update_note，因此会自动生成修订记录并刷新检索与链接。

        @param db 数据库会话
        @param note_id 目标笔记 ID
        @param user_id 操作人（用于 updated_by）
        @param text 追加内容，Markdown 或纯文本
        @returns (更新后的笔记, 错误信息)；失败时笔记为 None
        """
        if not text or not text.strip():
            return None, "追加内容不能为空"
        note = await NoteService.get_note(db, note_id)
        if not note:
            return None, "未找到笔记"
        if note.note_type not in ("markdown", "rich_text"):
            return None, f"仅支持 markdown/rich_text 类型，当前笔记类型: {note.note_type}"

        content = note.content or {}
        if note.note_type == "markdown":
            existing = content.get("text", "") if isinstance(content, dict) else ""
            new_content: dict = {"text": f"{existing}\n\n{text}" if existing else text}
        else:
            new_content = merge_rich_text_blocks(content, text)

        updated = await NoteService.update_note(
            db,
            note_id,
            {"content": new_content, "updated_by": user_id},
            change_summary="外部集成追加内容",
        )
        if not updated:
            return None, "追加失败"
        return updated, None

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
