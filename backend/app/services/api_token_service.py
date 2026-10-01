"""个人访问令牌服务 – 签发、校验与撤销。"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.api_token import UserApiToken
from app.models.user import User


class ApiTokenService:
    """个人访问令牌的签发、校验与撤销。

    令牌格式：``adn_`` 前缀 + 43 位 URL-safe 随机串。
    数据库只存 SHA-256 摘要，明文仅在签发响应中出现一次。
    """

    # 令牌固定前缀：认证时可据此快速分流，用户在日志里也能一眼识别
    TOKEN_PREFIX = "adn_"
    # 列表页展示的前缀长度（含 adn_）
    DISPLAY_PREFIX_LEN = 12
    # 随机部分长度（token_urlsafe(32) 约 43 字符）
    _RANDOM_BYTES = 32

    @staticmethod
    def hash_token(raw: str) -> str:
        """计算令牌的 SHA-256 摘要（hex）。

        @param raw 令牌明文
        @returns 摘要字符串
        """
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def generate_token() -> tuple[str, str, str]:
        """生成一枚新令牌。

        @returns (明文, sha256 摘要, 展示前缀)
        """
        raw = f"{ApiTokenService.TOKEN_PREFIX}{secrets.token_urlsafe(ApiTokenService._RANDOM_BYTES)}"
        return raw, ApiTokenService.hash_token(raw), raw[: ApiTokenService.DISPLAY_PREFIX_LEN]

    @staticmethod
    async def create_token(
        db: AsyncSession,
        user_id: UUID,
        name: str,
        expires_at: datetime | None = None,
    ) -> tuple[UserApiToken, str]:
        """签发令牌并落库。

        @param db 数据库会话
        @param user_id 所属用户
        @param name 令牌名称
        @param expires_at 过期时间，None 表示长期有效
        @returns (令牌记录, 明文令牌)；明文仅此一次返回
        """
        raw, digest, prefix = ApiTokenService.generate_token()
        token = UserApiToken(
            user_id=user_id,
            name=name,
            token_hash=digest,
            token_prefix=prefix,
            expires_at=expires_at,
        )
        db.add(token)
        await db.commit()
        await db.refresh(token)
        return token, raw

    @staticmethod
    async def list_tokens(db: AsyncSession, user_id: UUID) -> list[UserApiToken]:
        """列出用户全部令牌（不含明文），按创建时间倒序。

        @param db 数据库会话
        @param user_id 当前用户
        @returns 令牌记录列表
        """
        result = await db.execute(
            select(UserApiToken)
            .where(UserApiToken.user_id == user_id)
            .order_by(UserApiToken.created_at.desc())
        )
        return list(result.scalars().all())

    @staticmethod
    async def revoke_token(db: AsyncSession, user_id: UUID, token_id: UUID) -> bool:
        """撤销指定令牌（仅限本人操作）。

        @param db 数据库会话
        @param user_id 当前用户
        @param token_id 目标令牌 ID
        @returns 是否撤销成功
        """
        result = await db.execute(
            select(UserApiToken).where(
                UserApiToken.id == token_id,
                UserApiToken.user_id == user_id,
            )
        )
        token = result.scalar_one_or_none()
        if token is None:
            return False
        token.is_revoked = True
        await db.commit()
        return True

    @staticmethod
    async def authenticate(db: AsyncSession, raw_token: str) -> User | None:
        """校验令牌并返回对应用户，同时刷新 last_used_at。

        校验条件：摘要命中、未撤销、未过期、用户未删除且状态为 Active。

        @param db 数据库会话
        @param raw_token 请求携带的令牌明文
        @returns 合法则返回用户，否则 None
        """
        digest = ApiTokenService.hash_token(raw_token)
        result = await db.execute(
            select(UserApiToken).where(
                UserApiToken.token_hash == digest,
                UserApiToken.is_revoked == False,  # noqa: E712
            )
        )
        token = result.scalar_one_or_none()
        if token is None:
            return None

        now = datetime.now(timezone.utc)
        if token.expires_at is not None:
            expires_at = token.expires_at
            # 兼容数据库驱动返回 naive 时间的情况
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at <= now:
                return None

        user_result = await db.execute(
            select(User).where(
                User.id == token.user_id,
                User.is_deleted == False,  # noqa: E712
                User.status == "Active",
            )
        )
        user = user_result.scalar_one_or_none()
        if user is None:
            return None

        token.last_used_at = now
        await db.commit()
        return user