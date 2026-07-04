"""Authentication service."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import UUID

import bcrypt
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.user import User

settings = get_settings()


class AuthService:
    @staticmethod
    def hash_password(password: str) -> str:
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(12)).decode("utf-8")

    @staticmethod
    def verify_password(plain: str, hashed: str) -> bool:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))

    @staticmethod
    def create_access_token(user_id: UUID) -> tuple[str, int]:
        expires_delta = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
        expire = datetime.now(timezone.utc) + expires_delta
        payload = {
            "sub": str(user_id),
            "exp": expire,
            "type": "access",
        }
        token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
        return token, int(expires_delta.total_seconds())

    @staticmethod
    def create_refresh_token(user_id: UUID) -> str:
        expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
        payload = {
            "sub": str(user_id),
            "exp": expire,
            "type": "refresh",
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    @staticmethod
    async def register(db: AsyncSession, *, email: str, password: str, name: str) -> User | None:
        existing = await db.execute(
            select(User).where(User.email == email, User.is_deleted == False)  # noqa: E712
        )
        if existing.scalar_one_or_none():
            return None  # type: ignore[return-value]
        user = User(
            email=email,
            password_hash=AuthService.hash_password(password),
            name=name,
        )
        db.add(user)
        await db.flush()
        return user

    @staticmethod
    async def authenticate(db: AsyncSession, email: str, password: str) -> User | None:
        result = await db.execute(
            select(User).where(User.email == email, User.is_deleted == False)  # noqa: E712
        )
        user = result.scalar_one_or_none()
        if user is None or not AuthService.verify_password(password, user.password_hash):
            return None
        return user

    @staticmethod
    async def refresh_access_token(db: AsyncSession, refresh_token: str) -> tuple[str, int] | None:
        try:
            payload = jwt.decode(refresh_token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            if payload.get("type") != "refresh":
                return None
            user_id = UUID(payload["sub"])
        except (JWTError, ValueError, KeyError):
            return None
        result = await db.execute(
            select(User).where(User.id == user_id, User.is_deleted == False)  # noqa: E712
        )
        if result.scalar_one_or_none() is None:
            return None
        return AuthService.create_access_token(user_id)

    @staticmethod
    async def search_users(db: AsyncSession, q: str, limit: int = 20) -> list[User]:
        pattern = f"%{q.strip()}%"
        result = await db.execute(
            select(User)
            .where(
                User.is_deleted == False,  # noqa: E712
                User.status == "Active",
                (User.email.ilike(pattern) | User.name.ilike(pattern)),
            )
            .limit(limit)
        )
        return list(result.scalars().all())
