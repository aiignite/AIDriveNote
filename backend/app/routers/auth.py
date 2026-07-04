"""Auth API routes."""
from __future__ import annotations

from pydantic import BaseModel, EmailStr
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.database import get_db
from app.exceptions import ConflictException
from app.models.user import User
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["Authentication"])


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    access_token_expires_in: int


class UserOut(BaseModel):
    model_config = {"from_attributes": True}
    id: str
    email: str
    name: str
    status: str


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest, db: AsyncSession = Depends(get_db)):
    user = await AuthService.register(
        db, email=body.email, password=body.password, name=body.name,
    )
    if user is None:
        raise ConflictException("Email already registered")
    await db.commit()
    await db.refresh(user)
    return UserOut(id=str(user.id), email=user.email, name=user.name, status=user.status)


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
    return UserOut(id=str(user.id), email=user.email, name=user.name, status=user.status)
