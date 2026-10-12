"""匿名账号数据清除服务。

匿名用户的数据不长期保存：超过 ``GUEST_IDLE_TIMEOUT_MINUTES`` 无任何请求的
匿名账号，其笔记、AI 会话、上传文件乃至账号行都会被**物理删除**。

清除顺序本身就是正确性的一部分：

1. 录音文件必须**先取路径再删行**——``note_recordings`` 上有
   ``ON DELETE CASCADE``，删用户行会先带走记录，``storage_path`` 信息随之丢失，
   磁盘上的音频将成为无人认领的残留。
2. 图片资产是**全局内容寻址**（``uploads/note_assets/{hash}``，不带用户维度），
   因此只能先收集待删笔记引用的哈希，再统计全库剩余引用，**引用归零才删文件**，
   否则会误删他人笔记中内容相同的图。
3. 笔记必须**先按 created_by 显式删除，再删用户行**。``note_notes.created_by``
   是 ``ON DELETE SET NULL``，直接删用户行会让笔记变成 ``created_by IS NULL``
   的孤儿；而路由鉴权写的是 ``if note.created_by and ...``，``NULL`` 意味着
   这些笔记将对**所有人可见可写**。
"""
from __future__ import annotations

import contextlib
import logging
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from uuid import UUID

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.guest_event import GuestEventType
from app.models.note.note import Note, NoteFolder, NoteRevision, NoteShare, NoteTag, NoteTemplate
from app.models.note.recording import NoteRecording
from app.models.user import User
from app.services.guest_event_service import GuestEventService
from app.services.guest_service import GuestService
from app.services.note.note_asset_service import NoteAssetService
from app.services.note.recording import audio_storage

logger = logging.getLogger(__name__)


@contextlib.asynccontextmanager
async def _session_scope(db: AsyncSession | None = None) -> AsyncIterator[AsyncSession]:
    """提供 DB 会话：传入 ``db`` 则复用（测试可注入），否则自开会话。

    定时任务与登出接口走自开会话；单元测试注入 SQLite 会话，
    无需真实 Postgres 即可覆盖清除逻辑。
    """
    if db is not None:
        yield db
        return
    async with AsyncSessionLocal() as session:
        yield session


class GuestPurgeService:
    """匿名账号的物理清除。"""

    @staticmethod
    async def find_offline_guests(db: AsyncSession) -> list[User]:
        """找出所有超过宽限期未活动的匿名账号。

        ``last_seen_at`` 为空的匿名账号视为已过期——它从未收到过任何后续请求。
        """
        cutoff = GuestService.idle_cutoff()
        result = await db.execute(
            select(User).where(
                User.is_guest == True,  # noqa: E712
                User.is_deleted == False,  # noqa: E712
                User.guest_purged_at.is_(None),
                or_(User.last_seen_at.is_(None), User.last_seen_at < cutoff),
            )
        )
        return list(result.scalars().all())

    @staticmethod
    async def purge_offline_guests() -> int:
        """扫描并清除所有超时的匿名账号。返回清除的账号数。

        单个账号清除失败只记日志并继续，绝不中断整轮扫描。
        """
        purged = 0
        try:
            async with AsyncSessionLocal() as db:
                guests = await GuestPurgeService.find_offline_guests(db)
        except Exception:  # noqa: BLE001 — 扫描失败不应影响服务
            logger.exception("扫描超时匿名账号失败")
            return 0

        for guest in guests:
            guest_id = guest.id
            try:
                await GuestPurgeService.purge_guest(guest_id, reason="idle")
                purged += 1
            except Exception:  # noqa: BLE001 — 单个失败不影响其余
                logger.exception("清除匿名账号失败 user=%s", guest_id)
        if purged:
            logger.info("已清除 %s 个超时匿名账号", purged)
        return purged

    @staticmethod
    async def purge_guest(
        user_id: UUID, *, reason: str = "idle", db: AsyncSession | None = None,
    ) -> None:
        """物理清除单个匿名账号的全部数据与账号行。

        @param user_id 匿名账号 ID
        @param reason 清除原因：``idle``（超时）/ ``logout``（主动退出）/ ``manual``（管理员手动）
        @param db 可选复用会话；默认自开独立会话（测试可注入）
        """
        # 第一段：只读收集 —— 录音路径、资产哈希、笔记数、存活时长、登录信息
        async with _session_scope(db) as session:
            profile = await GuestPurgeService._collect(session, user_id)
            if profile is None:
                return  # 账号不存在或已清除，幂等返回
            session_seconds = profile["session_seconds"]
            note_count = profile["note_count"]

            # 第二段：文件清理 —— 在删行之前完成，避免路径信息随 CASCADE 丢失
            await GuestPurgeService._purge_files(profile, db=session)

            # 第三段：终态事件 —— 在删行之前写入（独立事务），含存活时长与笔记数
            await GuestEventService.record_in_new_session(
                db=session,
                guest_id=user_id,
                event_type=GuestEventType.SESSION_END,
                session_duration_seconds=session_seconds,
                note_count_at_end=note_count,
                detail=reason,
            )

            # 第四段：删除数据库数据
            await GuestPurgeService._delete_db_rows(session, user_id, profile)

        # 第五段：完成事件（账号行已删，事件因无外键而保留）
        await GuestEventService.record_in_new_session(
            guest_id=user_id,
            event_type=GuestEventType.PURGE,
            session_duration_seconds=session_seconds,
            note_count_at_end=note_count,
            detail=reason,
        )

    # ── 内部实现 ─────────────────────────────────────────────────────

    @staticmethod
    async def _collect(db: AsyncSession, user_id: UUID) -> dict | None:
        """收集清除所需的全部信息（只读）。账号不存在时返回 None。"""
        result = await db.execute(
            select(User).where(
                User.id == user_id,
                User.is_guest == True,  # noqa: E712
                User.guest_purged_at.is_(None),
            )
        )
        user = result.scalar_one_or_none()
        if user is None:
            return None

        note_count = (
            await db.execute(
                select(func.count()).select_from(Note).where(Note.created_by == user_id)
            )
        ).scalar() or 0

        # 录音的 storage_path 必须在删行前取出（CASCADE 会先带走记录）
        recording_rows = await db.execute(
            select(NoteRecording.storage_path).where(NoteRecording.user_id == user_id)
        )
        recording_paths = [p for p in recording_rows.scalars().all() if p]

        # 待删笔记引用的资产哈希
        note_rows = await db.execute(
            select(Note.content).where(Note.created_by == user_id)
        )
        asset_hashes: set[str] = set()
        for content in note_rows.scalars().all():
            asset_hashes |= NoteAssetService.find_asset_hashes(content)

        session_seconds: int | None = None
        if user.created_at:
            base = user.created_at
            end = user.last_seen_at
            try:
                if end and base.tzinfo is None and end.tzinfo is not None:
                    base = base.replace(tzinfo=end.tzinfo)
                session_seconds = max(0, int((end - base).total_seconds())) if end else None
            except (TypeError, AttributeError):
                session_seconds = None

        return {
            "user_id": user_id,
            "email": user.email,
            "recording_paths": recording_paths,
            "asset_hashes": asset_hashes,
            "note_count": note_count,
            "session_seconds": session_seconds,
        }

    @staticmethod
    async def _purge_files(profile: dict, *, db: AsyncSession | None = None) -> None:
        """清理磁盘文件。失败只记日志——磁盘残留可事后处理，DB 已无可指向它们的行。"""
        for storage_path in profile["recording_paths"]:
            try:
                audio_storage.delete_recording_file(storage_path)
            except Exception:  # noqa: BLE001
                logger.warning("删除录音文件失败 path=%s", storage_path, exc_info=True)

        # AI 附件目录 uploads/ai/{user_id}/：唯一带 user id 的目录，可整目录删除
        try:
            attachment_dir = GuestPurgeService._ai_attachment_dir(str(profile["user_id"]))
            if attachment_dir.is_dir():
                shutil.rmtree(attachment_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            logger.warning("删除匿名 AI 附件目录失败", exc_info=True)

        # 图片资产：引用计数归零才删
        await GuestPurgeService._purge_unreferenced_assets(
            profile["user_id"], profile["asset_hashes"], db=db,
        )

    @staticmethod
    def _ai_attachment_dir(user_id: str) -> Path:
        """AI 附件目录。基准与 AttachmentService._BACKEND_DIR 保持一致。"""
        backend_root = Path(__file__).resolve().parents[2]
        return backend_root / "uploads" / "ai" / user_id

    @staticmethod
    async def _purge_unreferenced_assets(
        user_id: UUID, hashes: set[str], *, db: AsyncSession | None = None,
    ) -> None:
        """仅删除已无任何笔记引用的资产文件。

        资产是内容寻址的全局资源，同一张图可能被多个用户的笔记共用；且回收站
        （``is_deleted=True``）里的笔记同样算引用，否则会删掉他人回收站中的图。
        """
        if not hashes:
            return
        async with _session_scope(db) as session:
            rows = await session.execute(
                select(Note.content).where(
                    or_(Note.created_by != user_id, Note.created_by.is_(None))
                )
            )
            live: set[str] = set()
            for content in rows.scalars().all():
                live |= NoteAssetService.find_asset_hashes(content)

        for file_hash in hashes - live:
            # 扩展名未知时遍历该哈希的所有已知扩展名
            for ext in ("png", "jpg", "gif", "webp", "bmp", "avif", "svg"):
                try:
                    NoteAssetService.delete_asset(file_hash, ext)
                except Exception:  # noqa: BLE001
                    logger.warning("删除匿名图片资产失败 hash=%s", file_hash[:8], exc_info=True)

    @staticmethod
    async def _delete_db_rows(db: AsyncSession, user_id: UUID, profile: dict) -> None:
        """删除数据库中的全部关联数据。顺序：先笔记，最后用户行。"""
        # 笔记：ORM 上的 cascade="all, delete-orphan" 连带清掉
        # tag_links / favorites / links / revisions / shares
        notes = await db.execute(
            select(Note).where(Note.created_by == user_id)
        )
        for note in notes.scalars().all():
            await db.delete(note)
        await db.flush()

        # 其他 user-scoped 数据（这些表的 user_id 是 SET NULL，不会随用户行级联）
        for model in (NoteTemplate, NoteRevision, NoteShare, NoteFolder, NoteTag):
            column = model.__table__.c
            if "created_by" in column:
                await db.execute(delete(model).where(column["created_by"] == user_id))
            if "user_id" in column:
                await db.execute(delete(model).where(column["user_id"] == user_id))
            if "changed_by" in column:
                await db.execute(delete(model).where(column["changed_by"] == user_id))
            if "shared_with_user_id" in column:
                await db.execute(
                    delete(model).where(column["shared_with_user_id"] == user_id)
                )

        # 匿名用户自建的 AI 模型/助手 **不删除**：它们的 user_id 是只写不读字段，
        # 模型实际全站共享（GET /ai/models 与 LLMRouter 均不过滤用户），
        # 删除会打断其他用户正在进行的会话。属公共资产，不随账号清除。

        # 邮箱验证码表以 email 字符串为键、无外键，需按邮箱清除
        from app.models.email_verification import EmailVerificationCode

        if profile.get("email"):
            await db.execute(
                delete(EmailVerificationCode).where(
                    EmailVerificationCode.email == profile["email"]
                )
            )

        # 最后删除用户行：其上 CASCADE 覆盖 folders/tags/favorites/recordings/
        # ai_conversations/ai_attachments/user_ai_settings/user_api_tokens，
        # 而 AIModel/AIAssistant 的 user_id 是 SET NULL，会自动置空。
        await db.execute(delete(User).where(User.id == user_id))
        await db.commit()
