"""笔记/文件夹加密的业务编排。

职责：

- 解析某条笔记的有效锁定对象（笔记自身加密优先，其次最近的加密祖先文件夹）；
- 对笔记正文执行加密 / 解密，并清理会泄漏明文的衍生数据（检索、embedding、修订）；
- 对文件夹做子树级批量加解密；
- 校验解锁票据并取出内容密钥；
- 提供简易的失败次数节流，抵御暴力猜密码。

密码校验统一复用 ``AuthService`` 的 bcrypt 实现；加解密与票据由
``app.services.note.note_crypto`` 提供。
"""
from __future__ import annotations

import logging
import time
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.note import Note, NoteFolder, NoteRevision

logger = logging.getLogger(__name__)
from app.services.auth_service import AuthService
from app.services.note import note_crypto
from app.services.note.note_service import NoteFolderService, NoteService

# 连续失败阈值与熔断时长
_MAX_FAILURES = 5
_LOCKOUT_SECONDS = 30
# 失败计数表：{(user_id, scope, target_id): (失败次数, 熔断截止时间戳)}
_failures: dict[tuple[str, str, str], tuple[int, float]] = {}


class NoteLockService:
    """加密笔记 / 文件夹的领域服务。"""

    # ── 锁定解析 ──────────────────────────────────────

    @staticmethod
    async def _ancestor_folders(db: AsyncSession, folder_id: UUID) -> list[NoteFolder]:
        """从指定文件夹向上收集祖先链（含自身），自近及远。"""
        chain: list[NoteFolder] = []
        seen: set[UUID] = set()
        current_id: UUID | None = folder_id
        while current_id and current_id not in seen:
            seen.add(current_id)
            folder = await NoteFolderService.get_folder(db, current_id)
            if not folder:
                break
            chain.append(folder)
            current_id = folder.parent_id
        return chain

    @staticmethod
    async def resolve_lock(db: AsyncSession, note: Note) -> tuple[str, UUID] | None:
        """解析笔记的有效锁定对象。

        @param db 数据库会话
        @param note 目标笔记
        @returns (``note``|``folder``, 对象 ID)；未加密返回 None
        """
        if note.is_encrypted:
            return ("note", note.id)
        if not note.folder_id:
            return None
        for folder in await NoteLockService._ancestor_folders(db, note.folder_id):
            if folder.is_encrypted:
                return ("folder", folder.id)
        return None

    @staticmethod
    async def get_target(db: AsyncSession, scope: str, target_id: UUID) -> Note | NoteFolder | None:
        """按范围取出锁定对象（笔记或文件夹）。"""
        if scope == "note":
            return await NoteService.get_note(db, target_id)
        return await NoteFolderService.get_folder(db, target_id)

    @staticmethod
    async def folder_lock(db: AsyncSession, folder_id: UUID | None) -> tuple[str, UUID] | None:
        """判断文件夹是否处于加密保护中（含祖先链），返回锁定对象。"""
        if not folder_id:
            return None
        for folder in await NoteLockService._ancestor_folders(db, folder_id):
            if folder.is_encrypted:
                return ("folder", folder.id)
        return None

    @staticmethod
    async def folder_is_locked(db: AsyncSession, folder_id: UUID | None) -> bool:
        """文件夹是否受加密保护（便捷包装）。"""
        return (await NoteLockService.folder_lock(db, folder_id)) is not None

    # ── 票据 ──────────────────────────────────────────

    @staticmethod
    def resolve_key_from_token(
        lock: tuple[str, UUID], token: str | None, user_id: UUID,
    ) -> str | None:
        """从解锁票据中取出与锁定对象匹配的内容密钥。

        @param lock ``resolve_lock`` 的结果
        @param token 前端传入的解锁票据
        @param user_id 当前用户
        @returns 匹配则返回密钥，否则 None
        """
        payload = note_crypto.parse_unlock_token(token)
        if not payload:
            return None
        scope, target_id = lock
        if payload.get("uid") != str(user_id):
            return None
        if payload.get("scope") != scope or payload.get("id") != str(target_id):
            return None
        return payload.get("key")

    # ── 明文泄漏清理 ──────────────────────────────────

    @staticmethod
    async def _clear_artifacts(db: AsyncSession, note: Note) -> None:
        """清除加密笔记的检索字段、历史修订与 RAG 分块（都含明文）。"""
        note.search_text = None
        note.search_vector = None
        note.content_embedding = None
        await db.execute(delete(NoteRevision).where(NoteRevision.note_id == note.id))
        # RAG v2 分块是新的明文落点：上锁必须同步清除，否则解锁前也能被检索命中
        if db.get_bind().dialect.name == "postgresql":
            try:
                for table in ("rag_chunks", "rag_documents", "rag_index_jobs"):
                    await db.execute(
                        text(f"DELETE FROM {table} WHERE note_id = :note_id"),
                        {"note_id": str(note.id)},
                    )
            except Exception:  # noqa: BLE001 — 未装 pgvector 时这些表不存在
                logger.debug("清理 RAG 分块失败（表可能不存在）", exc_info=True)

    # ── 笔记级加解密 ──────────────────────────────────

    @staticmethod
    async def encrypt_note(db: AsyncSession, note: Note, password: str) -> str:
        """加密单条笔记正文。

        @param db 数据库会话
        @param note 目标笔记
        @param password 用户设定的密码（明文，仅用于派生密钥与校验器）
        @returns 本次派生出的内容密钥（供立即解锁使用）
        """
        salt = note_crypto.new_salt()
        key = note_crypto.derive_fernet_key(password, salt)
        note.enc_salt = salt
        note.enc_verifier = AuthService.hash_password(password)
        note.content = note_crypto.encrypt_content(note.content, key)
        note.is_encrypted = True
        await NoteLockService._clear_artifacts(db, note)
        await db.commit()
        # commit 后 onupdate=server_default 的列会被标记过期；此处刷新，避免调用方
        # 序列化响应时触发异步上下文外的懒加载。
        await db.refresh(note)
        return key

    @staticmethod
    async def decrypt_note(db: AsyncSession, note: Note, password: str) -> bool:
        """用密码解密单条笔记正文并移除加密标记。

        @returns 密码正确且解密成功返回 True
        """
        if not note.enc_verifier or not AuthService.verify_password(password, note.enc_verifier):
            return False
        key = note_crypto.derive_fernet_key(password, note.enc_salt or "")
        content = note_crypto.decrypt_content(note.content, key)
        if content is None:
            return False
        note.content = content
        note.is_encrypted = False
        note.enc_salt = None
        note.enc_verifier = None
        await db.commit()
        await db.refresh(note)
        # 解密后重新进索引，否则这篇笔记在解锁期间依然搜不到
        from app.services.ai.embedding_service import schedule_note_embedding
        schedule_note_embedding(note.id)
        return True

    # ── 文件夹级加解密 ────────────────────────────────

    @staticmethod
    async def _subtree_notes(db: AsyncSession, folder_id: UUID) -> list[Note]:
        """收集文件夹（含子孙文件夹）内的全部未删除笔记。"""
        folder_ids = await NoteFolderService._collect_descendant_folder_ids(db, folder_id)
        folder_ids.add(folder_id)
        result = await db.execute(
            select(Note).where(
                Note.folder_id.in_(folder_ids),
                Note.is_deleted == False,  # noqa: E712
            )
        )
        return list(result.scalars().all())

    @staticmethod
    async def encrypt_folder(db: AsyncSession, folder: NoteFolder, password: str) -> tuple[str, int]:
        """加密文件夹：为其子树内笔记用文件夹密钥重新加密。

        已单独加密的笔记保持原状（自身密码优先）。

        @returns (文件夹密钥, 被加密的笔记数)
        """
        salt = note_crypto.new_salt()
        key = note_crypto.derive_fernet_key(password, salt)
        notes = await NoteLockService._subtree_notes(db, folder.id)
        count = 0
        for note in notes:
            if note.is_encrypted:
                continue
            note.content = note_crypto.encrypt_content(note.content, key)
            await NoteLockService._clear_artifacts(db, note)
            count += 1
        folder.enc_salt = salt
        folder.enc_verifier = AuthService.hash_password(password)
        folder.is_encrypted = True
        await db.commit()
        await db.refresh(folder)
        return key, count

    @staticmethod
    async def decrypt_folder(db: AsyncSession, folder: NoteFolder, password: str) -> int:
        """解密文件夹：还原子树内用文件夹密钥加密的笔记正文。

        @returns 被解密的笔记数；密码错误返回 -1
        """
        if not folder.enc_verifier or not AuthService.verify_password(password, folder.enc_verifier):
            return -1
        key = note_crypto.derive_fernet_key(password, folder.enc_salt or "")
        notes = await NoteLockService._subtree_notes(db, folder.id)
        count = 0
        decrypted_ids: list[UUID] = []
        for note in notes:
            if note.is_encrypted:
                continue  # 笔记自身加密，不属于文件夹密钥管辖
            if not note_crypto.is_encrypted_content(note.content):
                continue
            content = note_crypto.decrypt_content(note.content, key)
            if content is None:
                continue
            note.content = content
            count += 1
            decrypted_ids.append(note.id)
        folder.is_encrypted = False
        folder.enc_salt = None
        folder.enc_verifier = None
        await db.commit()
        await db.refresh(folder)
        from app.services.ai.embedding_service import schedule_note_embedding
        for note_id in decrypted_ids:
            schedule_note_embedding(note_id)
        return count

    # ── 解锁 ──────────────────────────────────────────

    @staticmethod
    async def verify_password(db: AsyncSession, scope: str, target_id: UUID, password: str) -> str | None:
        """校验密码并返回内容密钥；对象不存在或密码错误返回 None。"""
        target = await NoteLockService.get_target(db, scope, target_id)
        if target is None:
            return None
        if scope == "note":
            if not target.enc_salt or not target.enc_verifier:
                return None
        else:
            if not getattr(target, "enc_salt", None) or not getattr(target, "enc_verifier", None):
                return None
        if not AuthService.verify_password(password, target.enc_verifier):  # type: ignore[union-attr]
            return None
        return note_crypto.derive_fernet_key(password, target.enc_salt or "")  # type: ignore[union-attr]

    # ── 失败节流 ──────────────────────────────────────

    @staticmethod
    def check_throttle(user_id: UUID, scope: str, target_id: UUID) -> int:
        """检查是否处于熔断期；返回剩余秒数（0 表示可继续尝试）。"""
        count, until = _failures.get((str(user_id), scope, str(target_id)), (0, 0.0))
        remaining = int(until - time.time())
        return max(0, remaining)

    @staticmethod
    def record_failure(user_id: UUID, scope: str, target_id: UUID) -> None:
        """记录一次密码失败；达到阈值则进入熔断。"""
        key = (str(user_id), scope, str(target_id))
        count, _ = _failures.get(key, (0, 0.0))
        count += 1
        until = time.time() + _LOCKOUT_SECONDS if count >= _MAX_FAILURES else 0.0
        if until:
            count = 0  # 熔断后计数归零，熔断结束重新累计
        _failures[key] = (count, until)

    @staticmethod
    def record_success(user_id: UUID, scope: str, target_id: UUID) -> None:
        """密码正确后清除失败计数。"""
        _failures.pop((str(user_id), scope, str(target_id)), None)
