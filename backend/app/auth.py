"""JWT authentication dependencies with optional AIDriveAll SSO."""
from __future__ import annotations

import logging
import time
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

# 匿名账号心跳的落库节流：user_id → 上次写入 last_seen_at 的单调时钟读数。
# 每个请求都写库会给匿名会话带来无谓的 UPDATE，故按 PURGE_INTERVAL 节流；
# 30 分钟的宽限期对比 5 分钟的精度绰绰有余。
_last_seen_writes: dict[str, float] = {}
_LAST_SEEN_MAX_ENTRIES = 10_000


async def _resolve_tokens(
    request: Request,
    bearer: str | None = Depends(oauth2_scheme),
    aidrive_token: str | None = Cookie(default=None),
) -> tuple[str | None, str | None]:
    """解析请求携带的两类凭证，返回 ``(门户 SSO cookie 令牌, 应用 Bearer 令牌)``。

    两者**同时返回**，由 :func:`get_current_user` 决定回退顺序。

    旧实现把 SSO cookie 当成唯一凭证并优先采用，只要 ``SSO_ENABLED`` 为真且
    浏览器带着 ``aidrive_token``，就完全不看 Bearer 头；一旦门户 cookie 过期、
    或 ``SSO_SECRET_KEY`` 配置缺失（空值），解码必然失败，**即使同时携带了完全
    有效的 Bearer 也会整站 401**，用户只能靠清空浏览器缓存绕过。

    ``SSO_SECRET_KEY`` 为空时直接不走 cookie 通道：空密钥只会在解码阶段制造噪声。
    """
    sso_token = (
        aidrive_token
        if settings.SSO_ENABLED and settings.SSO_SECRET_KEY and aidrive_token
        else None
    )
    if bearer:
        return sso_token, bearer
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        return sso_token, auth_header[7:]
    return sso_token, None


def extract_client_ip(request: Request) -> str | None:
    """提取真实客户端 IP。

    nginx 已透传 ``X-Forwarded-For`` 与 ``X-Real-IP``（见 frontend/nginx.conf）。
    ``X-Forwarded-For`` 是「客户端, 代理1, 代理2」逗号串，**只取第一段**——
    尾段可被客户端伪造，取首位才是链路最上游的地址。
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first[:45]
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()[:45]
    if request.client:
        return request.client.host[:45]
    return None


def _should_write_last_seen(user: User) -> bool:
    """按节流间隔判断本次请求是否需要真正落库 ``last_seen_at``。"""
    now = time.monotonic()
    key = str(user.id)
    last = _last_seen_writes.get(key)
    if last is not None and now - last < settings.GUEST_PURGE_INTERVAL_SECONDS:
        return False
    if len(_last_seen_writes) >= _LAST_SEEN_MAX_ENTRIES:
        # 长期运行下条目只增不减，按写入时间粗粒度清理过期项，避免内存无界增长
        cutoff = now - settings.GUEST_PURGE_INTERVAL_SECONDS
        for stale in [k for k, v in _last_seen_writes.items() if v < cutoff]:
            _last_seen_writes.pop(stale, None)
        if len(_last_seen_writes) >= _LAST_SEEN_MAX_ENTRIES:
            _last_seen_writes.clear()
    _last_seen_writes[key] = now
    return True


async def _touch_guest_last_seen(db: AsyncSession, user: User) -> None:
    """认证成功后刷新匿名账号的存活时间（节流写库）。"""
    if not getattr(user, "is_guest", False):
        return
    if not _should_write_last_seen(user):
        return
    from app.services.guest_service import GuestService

    try:
        await GuestService.touch(db, user)
        await db.commit()
    except Exception:  # noqa: BLE001 — 心跳失败不应影响正常请求
        logger.warning("刷新匿名账号存活时间失败 user=%s", user.id, exc_info=True)
        await db.rollback()


async def get_current_user(
    token_info: tuple[str | None, str | None] = Depends(_resolve_tokens),
    db: AsyncSession = Depends(get_db),
) -> User:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    sso_token, bearer_token = token_info
    if not sso_token and not bearer_token:
        raise credentials_exception

    # 1) 门户 SSO cookie：解不出来不致命，继续尝试 Bearer ——
    #    过期 cookie 不该把持有有效应用令牌的用户挡在门外。
    if sso_token:
        try:
            claims = SSOService.decode_portal_token(sso_token)
            user, changed = await SSOService.sync_user_from_claims(db, claims)
            if changed:
                await db.commit()
            await _touch_guest_last_seen(db, user)
            return user
        except JWTError as exc:
            logger.warning("SSO JWT decode failed, fallback to bearer: %s", exc)
            if not bearer_token:
                raise credentials_exception from exc

    token = bearer_token
    if not token:
        raise credentials_exception

    # 个人访问令牌（PAT）：外部 Agent（MCP）无浏览器 Cookie，走独立校验分支。
    # 必须在 JWT 解析之前判断，因为 PAT 不是 JWT，直接解码必然失败。
    if token.startswith(ApiTokenService.TOKEN_PREFIX):
        user = await ApiTokenService.authenticate(db, token)
        if user is None:
            raise credentials_exception
        await _touch_guest_last_seen(db, user)
        return user

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
    await _touch_guest_last_seen(db, user)
    return user


def token_scopes(user: User) -> set[str] | None:
    """读取 PAT 的权限范围；None 表示交互式会话（拥有完整权限）。"""
    raw = getattr(user, "token_scopes", None)
    if raw is None:
        return None
    return {scope.strip() for scope in str(raw).split(",") if scope.strip()}


async def require_write_scope(user: User = Depends(get_current_user)) -> User:
    """写操作依赖：只读 PAT 不得创建 / 修改 / 删除笔记。"""
    scopes = token_scopes(user)
    if scopes is not None and "write" not in scopes:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="当前访问令牌只有只读权限",
        )
    return user


async def get_current_user_interactive(    request: Request,
    db: AsyncSession = Depends(get_db),
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
    # 匿名账号数据到期即被清除，签发的长期令牌会变成无主凭据，故一律禁止
    if getattr(user, "is_guest", False):
        await _record_blocked_event(request, user, "api_token_not_allowed", db)
        raise ForbiddenException("匿名模式下无法使用访问令牌功能，请登录后使用")
    return user


async def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise ForbiddenException("Admin access required")
    return user


async def _record_blocked_event(
    request: Request, user: User, detail: str, db: AsyncSession | None = None,
) -> None:
    """记录一次「匿名用户命中禁用功能」的事件。

    旁路写入：失败不影响 403 的正常返回。``detail`` 固定为枚举常量，
    不携带任何用户输入。
    """
    try:
        from app.models.guest_event import GuestEventType
        from app.services.guest_event_service import GuestEventService

        await GuestEventService.record_in_new_session(
            db=db,
            guest_id=user.id,
            event_type=GuestEventType.BLOCKED,
            ip_address=extract_client_ip(request),
            user_agent=request.headers.get("user-agent"),
            detail=detail,
        )
    except Exception:  # noqa: BLE001 — 审计旁路
        logger.warning("记录匿名禁用事件失败 detail=%s", detail, exc_info=True)


async def require_not_guest(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> User:
    """禁止匿名账号使用的功能守卫。

    用于录音转写、发邮件、访问令牌等：这些能力要么消耗服务端资源，要么会把
    匿名数据带出系统，而匿名账号的数据随时会被清除，留下的将是无主残留。
    """
    if getattr(user, "is_guest", False):
        await _record_blocked_event(request, user, "feature_not_allowed", db)
        raise ForbiddenException("该功能在匿名模式下不可用，请登录后使用")
    return user
