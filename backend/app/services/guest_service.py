"""匿名登录服务 – 匿名账号的创建与存活心跳。

设计要点：

- **每个匿名会话一条独立账号**。笔记按 ``created_by`` 隔离（``NoteService.list_notes``
  按 owner 过滤，路由 ``_assert_note_owner`` 拒绝非本人），若匿名访客共用一个账号，
  所有人将互相看到对方的笔记，属硬性隐私事故。users 表的膨胀由定时清除任务回收。
- 账号 ``role`` 固定为 ``guest``，永不是管理员，因此 ``get_current_admin`` 天然拦截。
- ``password_hash`` 存随机串的 bcrypt 哈希（与注册占位账号同款），
  确保匿名账号永远无法被任何密码命中，也不能走 ``POST /auth/login``。
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

import secrets
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.user import User
from app.services.auth_service import AuthService

logger = logging.getLogger(__name__)

# 匿名账号使用的邮箱域。不可投递（.local 由 mDNS 保留），且匿名流程不触碰任何
# 邮件逻辑，因此永远不会与真实邮箱或验证码记录冲突。
GUEST_EMAIL_DOMAIN = "guest.local"
GUEST_DISPLAY_NAME = "匿名用户"
GUEST_ROLE = "guest"


class GuestService:
    @staticmethod
    def build_guest_email() -> str:
        """合成一个唯一的匿名邮箱。

        ``users.email`` 是 ``unique NOT NULL``，用 uuid4hex 保证并发下不冲突。
        """
        return f"guest-{uuid.uuid4().hex}@{GUEST_EMAIL_DOMAIN}"

    @staticmethod
    async def create_guest(db: AsyncSession) -> User:
        """创建一条独立的匿名账号。

        与注册占位账号一致：用随机串的哈希填充 ``password_hash``（NOT NULL 列），
        使该账号无法通过密码登录；``status`` 为 Active 以通过 ``get_current_user``。
        """
        user = User(
            email=GuestService.build_guest_email(),
            # 不可能被人猜到的密码；哈希成本与普通账号一致，避免因耗时差异被区分
            password_hash=AuthService.hash_password(secrets.token_urlsafe(32)),
            name=GUEST_DISPLAY_NAME,
            role=GUEST_ROLE,
            status="Active",
            is_guest=True,
            last_seen_at=datetime.now(timezone.utc),
        )
        db.add(user)
        await db.flush()
        return user

    @staticmethod
    async def get_active_guest(db: AsyncSession, user_id: uuid.UUID) -> User | None:
        """按 ID 取一条「仍有效」的匿名账号。

        ``guest_purged_at`` 非空表示已清除完成，直接视为不存在。
        """
        result = await db.execute(
            select(User).where(
                User.id == user_id,
                User.is_guest == True,  # noqa: E712
                User.is_deleted == False,  # noqa: E712
                User.guest_purged_at.is_(None),
            )
        )
        return result.scalar_one_or_none()

    @staticmethod
    def is_guest(user: User) -> bool:
        """该用户是否为匿名账号。"""
        return bool(getattr(user, "is_guest", False))

    @staticmethod
    def idle_cutoff() -> datetime:
        """「离线超过宽限期」的时间基准。

        返回 ``now - GUEST_IDLE_TIMEOUT_MINUTES``，用于筛选
        ``last_seen_at`` 早于该时刻的匿名账号。
        """
        settings = get_settings()
        idle = max(1, int(settings.GUEST_IDLE_TIMEOUT_MINUTES))
        return datetime.now(timezone.utc) - timedelta(minutes=idle)

    @staticmethod
    async def touch(db: AsyncSession, user: User) -> None:
        """刷新 ``last_seen_at``（由 ``get_current_user`` 节流调用）。

        仅对匿名账号有意义：普通用户不受宽限期约束，无需为此写库。
        """
        if not GuestService.is_guest(user):
            return
        user.last_seen_at = datetime.now(timezone.utc)
