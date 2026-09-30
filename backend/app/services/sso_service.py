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
        status = payload.get("status", "active")
        if status != "active":
            raise JWTError("Portal account is not active")
        return payload

    @staticmethod
    def _portal_note_status(portal_status: str) -> str:
        return "Active" if portal_status == "active" else "Inactive"

    @staticmethod
    async def sync_user_from_claims(db: AsyncSession, claims: dict) -> tuple[User, bool]:
        email = claims["email"]
        name = claims.get("name") or email.split("@")[0]
        portal_role = claims.get("role", "user")
        portal_status = claims.get("status", "active")
        note_status = SSOService._portal_note_status(portal_status)
        target_role = "admin" if portal_role == "admin" else "user"

        result = await db.execute(
            select(User).where(User.email == email, User.is_deleted == False)  # noqa: E712
        )
        user = result.scalar_one_or_none()

        if user is None:
            user = User(
                email=email,
                name=name,
                password_hash=AuthService.hash_password(secrets.token_urlsafe(32)),
                role=target_role,
                status=note_status,
            )
            db.add(user)
            await db.flush()
            return user, True

        changed = False
        if user.name != name:
            user.name = name
            changed = True
        if portal_role == "admin" and user.role != "admin":
            user.role = "admin"
            changed = True
        if user.status != note_status:
            user.status = note_status
            changed = True

        if changed:
            await db.flush()
        return user, changed
