"""匿名登录事件记录服务。

只记录**元数据**：IP、User-Agent、存活时长、笔记数量。绝不记录笔记标题、正文、
文件名或任何用户输入——否则事件表本身会成为数据泄露面，并与「匿名数据不长期保存」
的产品承诺相冲突。

可靠性要求：事件写入是**旁路**，任何失败都只记日志，绝不影响登录或清除主流程。
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.guest_event import GuestEvent, GuestEventType

logger = logging.getLogger(__name__)

# User-Agent 截断上限，与表列宽一致
_MAX_UA_LENGTH = 300
# detail 截断上限；只接受固定枚举值，此处仅作兜底防御
_MAX_DETAIL_LENGTH = 200


class GuestEventService:
    @staticmethod
    async def record(
        db: AsyncSession,
        *,
        guest_id: UUID,
        event_type: GuestEventType,
        ip_address: str | None = None,
        user_agent: str | None = None,
        session_duration_seconds: int | None = None,
        note_count_at_end: int | None = None,
        detail: str | None = None,
    ) -> None:
        """写入一条匿名事件。

        不抛出异常：审计失败不得影响主流程。``GUEST_EVENTS_ENABLED=false`` 时直接跳过。
        """
        if not get_settings().GUEST_EVENTS_ENABLED:
            return
        try:
            event = GuestEvent(
                guest_id=guest_id,
                event_type=event_type.value,
                ip_address=(ip_address or None),
                user_agent=(user_agent or "")[:_MAX_UA_LENGTH] or None,
                event_at=datetime.now(timezone.utc),
                session_duration_seconds=session_duration_seconds,
                note_count_at_end=note_count_at_end,
                detail=(detail or "")[:_MAX_DETAIL_LENGTH] or None,
            )
            db.add(event)
            await db.commit()
        except Exception:  # noqa: BLE001 — 审计旁路，失败仅记录
            logger.warning(
                "写入匿名事件失败 guest=%s type=%s", guest_id, event_type, exc_info=True,
            )
            try:
                await db.rollback()
            except Exception:  # noqa: BLE001 — 回滚失败同样不应冒泡
                logger.warning("匿名事件回滚失败 guest=%s", guest_id)

    @staticmethod
    async def record_in_new_session(*, db: AsyncSession | None = None, **kwargs) -> None:
        """用**独立短事务**写入事件。

        清除任务等场景里，业务事务可能已经提交或即将回滚，复用同一 session 会让
        事件随业务事务一起丢失。这里自开会话，保证事件独立落库。

        测试可传入 ``db`` 复用会话断言写入结果。
        """
        if not get_settings().GUEST_EVENTS_ENABLED:
            return
        if db is not None:
            await GuestEventService.record(db, **kwargs)
            return
        from app.database import AsyncSessionLocal

        try:
            async with AsyncSessionLocal() as session:
                await GuestEventService.record(session, **kwargs)
        except Exception:  # noqa: BLE001 — 审计旁路，失败仅记录
            logger.warning("写入匿名事件失败(独立会话) %s", kwargs.get("event_type"))

    @staticmethod
    async def list_events(
        db: AsyncSession,
        *,
        guest_id: UUID | None = None,
        event_type: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[GuestEvent], int]:
        """按条件查询事件（时间倒序），返回 ``(当前页, 总数)``。"""
        base = select(GuestEvent)
        count_stmt = select(func.count()).select_from(GuestEvent)

        conditions = []
        if guest_id is not None:
            conditions.append(GuestEvent.guest_id == guest_id)
        if event_type:
            conditions.append(GuestEvent.event_type == event_type)
        if since is not None:
            conditions.append(GuestEvent.event_at >= since)
        if until is not None:
            conditions.append(GuestEvent.event_at <= until)
        for condition in conditions:
            base = base.where(condition)
            count_stmt = count_stmt.where(condition)

        total = (await db.execute(count_stmt)).scalar() or 0
        result = await db.execute(
            base.order_by(GuestEvent.event_at.desc()).offset(offset).limit(limit),
        )
        return list(result.scalars().all()), total

    @staticmethod
    async def stats(db: AsyncSession) -> dict:
        """匿名使用情况聚合：会话数、独立访客数、各事件类型计数。"""
        total_events = (
            await db.execute(select(func.count()).select_from(GuestEvent))
        ).scalar() or 0

        distinct_guests = (
            await db.execute(
                select(func.count(func.distinct(GuestEvent.guest_id))).select_from(GuestEvent),
            )
        ).scalar() or 0

        type_rows = await db.execute(
            select(GuestEvent.event_type, func.count())
            .group_by(GuestEvent.event_type)
            .order_by(func.count().desc()),
        )
        by_type = {event_type: count for event_type, count in type_rows.all()}

        # 匿名登录次数 / 清除次数，反映「有多少人在用」与「留存多久」
        return {
            "total_events": total_events,
            "distinct_guests": distinct_guests,
            "by_event_type": by_type,
            "logins": by_type.get(GuestEventType.LOGIN.value, 0),
            "logouts": by_type.get(GuestEventType.LOGOUT.value, 0),
            "purges": by_type.get(GuestEventType.PURGE.value, 0),
        }
