"""匿名登录事件查询 API（管理员）。

事件表**故意没有** ``users`` 外键：匿名账号到期会被物理清除，而事件需要在其后
继续保留，用于统计「有多少人在用匿名登录」与审计回溯。
"""
from __future__ import annotations

from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_admin
from app.database import get_db
from app.models.user import User
from app.services.guest_event_service import GuestEventService
from app.services.guest_purge_service import GuestPurgeService

router = APIRouter(prefix="/admin", tags=["Admin Guest Events"])


class GuestEventOut(BaseModel):
    model_config = {"from_attributes": True}

    id: UUID
    guest_id: UUID
    event_type: str
    ip_address: str | None = None
    user_agent: str | None = None
    event_at: datetime
    session_duration_seconds: int | None = None
    note_count_at_end: int | None = None
    detail: str | None = None


class GuestEventListOut(BaseModel):
    items: list[GuestEventOut]
    total: int


class GuestEventStatsOut(BaseModel):
    total_events: int
    distinct_guests: int
    by_event_type: dict[str, int]
    logins: int
    logouts: int
    purges: int


@router.get("/guest-events", response_model=GuestEventListOut)
async def list_guest_events(
    guest_id: UUID | None = Query(None, description="按匿名账号筛选"),
    event_type: str | None = Query(None, description="login/logout/session_end/purge/blocked"),
    since: datetime | None = Query(None, description="起始时间（含）"),
    until: datetime | None = Query(None, description="结束时间（含）"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    """按条件查询匿名事件（时间倒序）。"""
    items, total = await GuestEventService.list_events(
        db,
        guest_id=guest_id,
        event_type=event_type,
        since=since,
        until=until,
        offset=offset,
        limit=limit,
    )
    return GuestEventListOut(
        items=[GuestEventOut.model_validate(i) for i in items], total=total,
    )


@router.get("/guest-events/stats", response_model=GuestEventStatsOut)
async def guest_event_stats(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    """匿名使用情况聚合。"""
    return GuestEventStatsOut(**await GuestEventService.stats(db))


@router.post("/guests/purge")
async def purge_guests_now(
    _admin: User = Depends(get_current_admin),
):
    """立即执行一次「清除超时匿名账号」。

    供管理员排障与验收验证；与后台定时任务调用同一段逻辑，均为幂等操作。
    """
    purged = await GuestPurgeService.purge_offline_guests()
    return {"ok": True, "purged": purged}
