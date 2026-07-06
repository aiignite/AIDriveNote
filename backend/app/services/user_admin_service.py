"""Admin user management service."""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.models.user import User

VALID_STATUSES = {"Active", "Inactive"}
VALID_ROLES = {"user", "admin"}


class UserAdminService:
    @staticmethod
    async def list_users(
        db: AsyncSession,
        *,
        q: str | None = None,
        role: str | None = None,
        status: str | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[User], int]:
        base = select(User).where(User.is_deleted == False)  # noqa: E712

        if q:
            pattern = f"%{q.strip()}%"
            base = base.where(or_(User.email.ilike(pattern), User.name.ilike(pattern)))
        if role:
            base = base.where(User.role == role)
        if status:
            base = base.where(User.status == status)

        count_result = await db.execute(select(func.count()).select_from(base.subquery()))
        total = count_result.scalar_one()

        result = await db.execute(
            base.order_by(User.created_at.desc()).offset(offset).limit(limit)
        )
        return list(result.scalars().all()), total

    @staticmethod
    async def get_user(db: AsyncSession, user_id: UUID) -> User:
        result = await db.execute(
            select(User).where(User.id == user_id, User.is_deleted == False)  # noqa: E712
        )
        user = result.scalar_one_or_none()
        if user is None:
            raise NotFoundException("User", str(user_id))
        return user

    @staticmethod
    async def count_admins(db: AsyncSession) -> int:
        result = await db.execute(
            select(func.count())
            .select_from(User)
            .where(
                User.is_deleted == False,  # noqa: E712
                User.role == "admin",
            )
        )
        return result.scalar_one()

    @staticmethod
    async def update_user(
        db: AsyncSession,
        *,
        target: User,
        actor: User,
        name: str | None = None,
        status: str | None = None,
        role: str | None = None,
    ) -> User:
        if status is not None:
            if status not in VALID_STATUSES:
                raise BadRequestException(f"Invalid status: {status}")
            if target.id == actor.id and status != "Active":
                raise ForbiddenException("Cannot deactivate your own account")

        if role is not None:
            if role not in VALID_ROLES:
                raise BadRequestException(f"Invalid role: {role}")
            if target.id == actor.id and role != "admin":
                raise ForbiddenException("Cannot demote your own admin role")
            if target.role == "admin" and role == "user":
                admin_count = await UserAdminService.count_admins(db)
                if admin_count <= 1:
                    raise BadRequestException("Cannot demote the last admin")

        if name is not None:
            trimmed = name.strip()
            if not trimmed:
                raise BadRequestException("Name cannot be empty")
            target.name = trimmed
        if status is not None:
            target.status = status
        if role is not None:
            target.role = role

        await db.flush()
        return target
