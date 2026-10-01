"""个人访问令牌 API – 供外部 Agent（MCP）接入笔记。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user_interactive
from app.database import get_db
from app.exceptions import NotFoundException
from app.models.user import User
from app.services.api_token_service import ApiTokenService

router = APIRouter(prefix="/api-tokens", tags=["API Tokens"])


class ApiTokenCreate(BaseModel):
    """创建令牌请求。"""

    # 令牌名称，帮助用户区分用途（如「Claude Desktop」）
    name: str = Field(..., min_length=1, max_length=100)
    # 有效期天数；不传表示长期有效
    expires_in_days: Optional[int] = Field(default=None, gt=0, le=3650)


class ApiTokenOut(BaseModel):
    """令牌列表项（不含明文）。"""

    model_config = {"from_attributes": True}
    id: UUID
    name: str
    token_prefix: str
    last_used_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    is_revoked: bool
    created_at: Optional[datetime] = None


class ApiTokenCreated(ApiTokenOut):
    """创建响应，额外返回仅此一次的明文令牌。"""

    token: str


@router.get("", response_model=list[ApiTokenOut])
async def list_api_tokens(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user_interactive),
):
    """列出当前用户的全部访问令牌（不含明文）。"""
    return await ApiTokenService.list_tokens(db, user.id)


@router.post("", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
async def create_api_token(
    body: ApiTokenCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user_interactive),
):
    """签发新令牌；明文令牌仅在本响应中返回一次。"""
    expires_at = None
    if body.expires_in_days:
        expires_at = datetime.now(timezone.utc) + timedelta(days=body.expires_in_days)
    token, raw = await ApiTokenService.create_token(
        db, user.id, body.name, expires_at=expires_at,
    )
    payload = ApiTokenOut.model_validate(token).model_dump()
    return ApiTokenCreated(**payload, token=raw)


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_api_token(
    token_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user_interactive),
):
    """撤销指定令牌（软删除，保留审计痕迹）。"""
    ok = await ApiTokenService.revoke_token(db, user.id, token_id)
    if not ok:
        raise NotFoundException("ApiToken")