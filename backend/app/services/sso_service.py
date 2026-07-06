"""SSO user sync from AIDriveAll portal JWT."""
from __future__ import annotations

import secrets

from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.user import User
from app.services.auth_service import AuthService

settings = get_settings()


class SSOService:
    @staticmethod
    def decode_portal_token(token: str) -> dict:
        secret = settings.SSO_SECRET_KEY or settings.SECRET_KEY
        payload = jwt.decode(token, secret, algorithms=[settings.ALGORITHM])
        if payload.get("iss") != settings.SSO_ISSUER:
            raise JWTError("Invalid issuer")
        if payload.get("type", "access") != "access":
            raise JWTError("Invalid token type")
        if not payload.get("email"):
            raise JWTError("Missing email claim")
        return payload

    @staticmethod
    async def sync_user_from_claims(db: AsyncSession, claims: dict) -> User:
        email = claims["email"]
        name = claims.get("name") or email.split("@")[0]
        portal_role = claims.get("role", "user")

        result = await db.execute(
            select(User).where(User.email == email, User.is_deleted == False)  # noqa: E712
        )
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                email=email,
                name=name,
                password_hash=AuthService.hash_password(secrets.token_urlsafe(32)),
                role="admin" if portal_role == "admin" else "user",
                status="Active",
            )
            db.add(user)
            await db.flush()
        else:
            user.name = name
            if portal_role == "admin":
                user.role = "admin"
            user.status = "Active"
            await db.flush()

        return user
