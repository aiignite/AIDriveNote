"""Auth API routes."""
from __future__ import annotations

import secrets

from pydantic import BaseModel, EmailStr, Field
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.config import get_settings
from app.database import get_db
from app.exceptions import BadRequestException, ConflictException, ForbiddenException
from app.models.user import User
from app.services.admin_bootstrap import AdminBootstrap
from app.services.auth_service import AuthService
from app.services.email_verification_service import EmailVerificationService

router = APIRouter(prefix="/auth", tags=["Authentication"])


def _require_registration_enabled() -> None:
    """公网测试部署防护：未开放自助注册时拒绝注册三步流程。

    账号一律由管理员在后台创建；前端通过 ``GET /auth/config`` 隐藏注册入口。
    """
    if not get_settings().SELF_REGISTRATION_ENABLED:
        raise ForbiddenException("当前未开放注册，请联系管理员开通账号")


class RegisterCodeRequest(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=100)


class VerifyCodeRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=8)


class CompleteRegisterRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=4, max_length=8)
    # 与现有前端 minLength 6 保持一致
    new_password: str = Field(min_length=6, max_length=72)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    model_config = {"from_attributes": True}
    id: str
    email: str
    name: str
    status: str
    role: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    access_token_expires_in: int
    # 登录时一并返回用户信息，前端可省去一次 /auth/me 往返（refresh 无用户上下文，为 None）
    user: UserOut | None = None


@router.get("/config")
async def auth_config():
    """公开的认证配置：前端据此显示/隐藏注册入口（无需登录）。"""
    return {"registration_enabled": get_settings().SELF_REGISTRATION_ENABLED}


@router.post("/register/request", dependencies=[Depends(_require_registration_enabled)])
async def register_request(body: RegisterCodeRequest, db: AsyncSession = Depends(get_db)):
    """第一步：校验邮箱并发送注册验证码。

    已注册邮箱返回 409 引导去登录；未注册邮箱创建 Pending 占位用户后发码。
    发码失败（SMTP 异常）时整体回滚，不残留占位用户与验证码记录。
    """
    email = EmailVerificationService.normalize_email(body.email)
    name = body.name.strip()

    result = await db.execute(
        select(User).where(User.email == email, User.is_deleted == False)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if user is not None and user.status == "Active":
        raise ConflictException("该邮箱已注册，请直接登录")

    if user is None:
        user = User(
            email=email,
            # 占位密码为不可能命中的随机串，确保 Pending 账号无法凭密码登录
            password_hash=AuthService.hash_password(secrets.token_urlsafe(32)),
            name=name,
            role="admin" if AdminBootstrap.is_admin_email(email) else "user",
            status="Pending",
        )
        db.add(user)
        await db.flush()
    else:
        # 中途放弃后重新注册：复用 Pending 占位并同步最新姓名
        user.name = name

    await EmailVerificationService.send_register_code(db, email=email)
    await db.commit()
    return {"message": "验证码已发送，请查收邮件"}


@router.post("/register/verify-code", dependencies=[Depends(_require_registration_enabled)])
async def register_verify_code(body: VerifyCodeRequest, db: AsyncSession = Depends(get_db)):
    """第二步：独立验码（不消费），供前端在设置密码前确认。"""
    await EmailVerificationService.verify_code(
        db, email=body.email, code=body.code, consume=False,
    )
    await db.commit()
    return {"valid": True}


@router.post("/register/complete", response_model=UserOut, dependencies=[Depends(_require_registration_enabled)])
async def register_complete(body: CompleteRegisterRequest, db: AsyncSession = Depends(get_db)):
    """第三步：验码并消费，设置密码后激活账号。"""
    email = EmailVerificationService.normalize_email(body.email)

    result = await db.execute(
        select(User).where(User.email == email, User.is_deleted == False)  # noqa: E712
    )
    user = result.scalar_one_or_none()
    if user is None:
        raise BadRequestException("注册请求不存在，请重新开始注册")
    if user.status == "Active":
        raise ConflictException("该邮箱已注册，请直接登录")

    await EmailVerificationService.verify_code(
        db, email=email, code=body.code, consume=True,
    )
    user.password_hash = AuthService.hash_password(body.new_password)
    user.status = "Active"
    await db.commit()
    await db.refresh(user)
    return UserOut(
        id=str(user.id), email=user.email, name=user.name, status=user.status, role=user.role,
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await AuthService.authenticate(db, body.email, body.password)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password")
    access_token, expires_in = AuthService.create_access_token(user.id)
    refresh_token = AuthService.create_refresh_token(user.id)
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        access_token_expires_in=expires_in,
        user=UserOut(
            id=str(user.id), email=user.email, name=user.name, status=user.status, role=user.role,
        ),
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: AsyncSession = Depends(get_db)):
    result = await AuthService.refresh_access_token(db, body.refresh_token)
    if result is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    access_token, expires_in = result
    return TokenResponse(
        access_token=access_token,
        refresh_token=body.refresh_token,
        access_token_expires_in=expires_in,
    )


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return UserOut(
        id=str(user.id), email=user.email, name=user.name, status=user.status, role=user.role,
    )
