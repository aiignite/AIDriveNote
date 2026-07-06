"""Bootstrap admin user from ADMIN_EMAIL."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.user import User

settings = get_settings()


class AdminBootstrap:
    @staticmethod
    async def ensure_admin_by_email(db: AsyncSession, email: str | None) -> None:
        if not email:
            return
        normalized = email.strip().lower()
        if not normalized:
            return
        result = await db.execute(
            select(User).where(
                User.email.ilike(normalized),
                User.is_deleted == False,  # noqa: E712
            )
        )
        user = result.scalar_one_or_none()
        if user is None or user.role == "admin":
            return
        user.role = "admin"
        await db.commit()

    @staticmethod
    async def ensure_configured_admin(db: AsyncSession) -> None:
        await AdminBootstrap.ensure_admin_by_email(db, settings.ADMIN_EMAIL)

    @staticmethod
    def is_admin_email(email: str) -> bool:
        if not settings.ADMIN_EMAIL:
            return False
        return email.strip().lower() == settings.ADMIN_EMAIL.strip().lower()
