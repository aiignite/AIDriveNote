"""User search for sharing."""
from __future__ import annotations

from pydantic import BaseModel
from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import require_not_guest
from app.database import get_db
from app.models.user import User
from app.services.auth_service import AuthService

router = APIRouter(prefix="/users", tags=["Users"])


class UserSearchOut(BaseModel):
    id: str
    email: str
    name: str


@router.get("/search", response_model=list[UserSearchOut])
async def search_users(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_not_guest),
):
    """搜索用户（用于笔记分享）。

    匿名账号禁用：匿名笔记在数据清除后即失去所有者，若已分享给他人，
    收件方会留下一份无法追溯也无法回收的无主副本。
    """
    users = await AuthService.search_users(db, q, limit=limit)
    return [
        UserSearchOut(id=str(u.id), email=u.email, name=u.name)
        for u in users
        if u.id != user.id
    ]
