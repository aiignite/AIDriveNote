"""JWT authentication dependencies with optional AIDriveAll SSO."""
from __future__ import annotations

import logging
from uuid import UUID

from fastapi import Cookie, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import get_db
from app.exceptions import ForbiddenException
from app.models.user import User
from app.services.api_token_service import ApiTokenService
from app.services.sso_service import SSOService

logger = logging.getLogger(__name__)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)
settings = get_settings()


async def _resolve_bearer_token(
    request: Request,
    bearer: str | None = Depends(oauth2_scheme),
    aidrive_token: str | None = Cookie(default=None),
) -> tuple[str | None, bool]:
    """Return (token, is_sso). SSO cookie takes precedence when enabled."""
    if settings.SSO_ENABLED and aidrive_token:
        return aidrive_token, True
    if bearer:
        return bearer, False
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return auth_header[7:], False
    return None, False


async def get_current_user(
    token_info: tuple[str | None, bool] = Depends(_resolve_bearer_token),
    db: AsyncSession = Depends(get_db),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    token, is_sso = token_info
    if not token:
        raise credentials_exception

    # 个人访问令牌（PAT）：外部 Agent（MCP）无浏览器 Cookie，走独立校验分支。
    # 必须在 JWT 解析之前判断，因为 PAT 不是 JWT，直接解码必然失败。
    if token.startswith(ApiTokenService.TOKEN_PREFIX):
        user = await ApiTokenService.authenticate(db, token)
        if user is None:
            raise credentials_exception
        return user

    if is_sso and settings.SSO_ENABLED:
        try:
            claims = SSOService.decode_portal_token(token)
            user, changed = await SSOService.sync_user_from_claims(db, claims)
            if changed:
                await db.commit()
            return user
        except JWTError as exc:
            logger.warning("SSO JWT decode failed: %s", exc)
            raise credentials_exception from exc

    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        sub: str | None = payload.get("sub")
        if sub is None or payload.get("type", "access") != "access":
            raise credentials_exception
        user_id = UUID(sub)
    except (JWTError, ValueError) as exc:
        logger.warning("JWT decode failed: %s", exc)
        raise credentials_exception from exc

    result = await db.execute(
        select(User).where(User.id == user_id, User.is_deleted == False)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if user is None or user.status != "Active":
        raise credentials_exception
    return user


async def get_current_user_interactive(
    request: Request,
    user: User = Depends(get_current_user),
) -> User:
    """仅允许交互式会话（JWT / SSO）的依赖。

    令牌签发等高敏感操作使用它，避免「用访问令牌再签发访问令牌」
    造成权限失控：一次泄露可能被用来持续续期。

    @param request 原始请求，用于检查 Authorization 头
    @param user 已通过 get_current_user 校验的用户
    @returns 交互式会话对应的用户
    """
    auth_header = request.headers.get("Authorization") or ""
    if auth_header.startswith("Bearer "):
        selected = auth_header[7:]
        if selected.startswith(ApiTokenService.TOKEN_PREFIX):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="访问令牌不能用于管理访问令牌，请使用网页登录会话",
            )
    return user


async def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise ForbiddenException("Admin access required")
    return user
