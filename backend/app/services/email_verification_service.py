"""邮箱验证码服务 —— 注册邮件确认码（参照 AIIgnitePLM 同名机制）。

验证码只以 SHA-256 摘要入库，明文仅在生成与发信瞬间存在。有效期、发送
冷却与错误尝试上限来自 ``app.config.Settings``；单实例部署下冷却用数据库
查询实现，不引入 Redis。

事务约定：``send_register_code`` 发信失败会抛出异常，调用方（路由层）
须回滚整个事务，避免落库一条从未送达的验证码。
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.exceptions import BadRequestException
from app.models.email_verification import EmailVerificationCode
from app.services.email_service import EmailService

# 验证码用途；当前仅注册，预留 reset 等后续扩展
PURPOSE_REGISTER = "register"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware(dt: datetime) -> datetime:
    """兼容数据库驱动返回 naive 时间的情况（SQLite 测试库）。"""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


class EmailVerificationService:
    @staticmethod
    def normalize_email(email: str) -> str:
        """邮箱归一化：发码与验码两侧必须用同一形态查询。"""
        return (email or "").strip().lower()

    @staticmethod
    def generate_code() -> str:
        """密码学安全随机数字验证码，前导补零。"""
        length = max(4, int(get_settings().EMAIL_CODE_LENGTH))
        return f"{secrets.randbelow(10 ** length):0{length}d}"

    @staticmethod
    def hash_code(code: str) -> str:
        return hashlib.sha256((code or "").strip().encode("utf-8")).hexdigest()

    @staticmethod
    async def _latest_code(
        db: AsyncSession, email: str, purpose: str,
    ) -> EmailVerificationCode | None:
        result = await db.execute(
            select(EmailVerificationCode)
            .where(
                EmailVerificationCode.email == email,
                EmailVerificationCode.purpose == purpose,
            )
            .order_by(
                EmailVerificationCode.created_at.desc(),
                EmailVerificationCode.id.desc(),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def send_register_code(db: AsyncSession, *, email: str) -> None:
        """为注册发送验证码；冷却窗口内抛 400，发信失败抛 502/503。"""
        settings = get_settings()
        email = EmailVerificationService.normalize_email(email)

        latest = await EmailVerificationService._latest_code(db, email, PURPOSE_REGISTER)
        if latest is not None and latest.created_at is not None:
            elapsed = _now() - _as_aware(latest.created_at)
            cooldown = timedelta(seconds=settings.EMAIL_CODE_SEND_COOLDOWN_SECONDS)
            if elapsed < cooldown:
                raise BadRequestException("发送过于频繁，请稍后再试")

        code = EmailVerificationService.generate_code()
        now = _now()
        # 新码生效前作废旧未消费码：同一邮箱同一用途始终只有一个有效码
        await db.execute(
            update(EmailVerificationCode)
            .where(
                EmailVerificationCode.email == email,
                EmailVerificationCode.purpose == PURPOSE_REGISTER,
                EmailVerificationCode.consumed_at.is_(None),
            )
            .values(consumed_at=now)
        )
        db.add(EmailVerificationCode(
            email=email,
            purpose=PURPOSE_REGISTER,
            code_hash=EmailVerificationService.hash_code(code),
            expires_at=now + timedelta(minutes=settings.EMAIL_CODE_TTL_MINUTES),
        ))
        await db.flush()

        await EmailService.send_verification_code(
            email=email, code=code, ttl_minutes=settings.EMAIL_CODE_TTL_MINUTES,
        )

    @staticmethod
    async def verify_code(
        db: AsyncSession,
        *,
        email: str,
        code: str,
        purpose: str = PURPOSE_REGISTER,
        consume: bool = False,
    ) -> None:
        """校验验证码；任何失败抛 BadRequestException。

        :param consume: True 时校验通过即消费（打 consumed_at），
            用于注册完成这类一次性动作；独立验码接口传 False。
        """
        settings = get_settings()
        email = EmailVerificationService.normalize_email(email)

        result = await db.execute(
            select(EmailVerificationCode)
            .where(
                EmailVerificationCode.email == email,
                EmailVerificationCode.purpose == purpose,
                EmailVerificationCode.consumed_at.is_(None),
            )
            .order_by(
                EmailVerificationCode.created_at.desc(),
                EmailVerificationCode.id.desc(),
            )
            .limit(1)
        )
        record = result.scalar_one_or_none()
        if record is None:
            raise BadRequestException("验证码无效或已过期")

        # 错误尝试上限先于哈希比较：封住对已过期/已封禁码的持续试探
        if record.attempt_count >= settings.EMAIL_CODE_MAX_VERIFY_ATTEMPTS:
            raise BadRequestException("验证码尝试次数过多，请重新获取")

        if record.code_hash != EmailVerificationService.hash_code(code):
            record.attempt_count += 1
            # 计数必须随失败一并落库：get_db 对异常路径回滚，不提交则尝试上限形同虚设
            await db.commit()
            raise BadRequestException("验证码错误")

        if _as_aware(record.expires_at) <= _now():
            raise BadRequestException("验证码无效或已过期")

        if consume:
            record.consumed_at = _now()
            await db.flush()
