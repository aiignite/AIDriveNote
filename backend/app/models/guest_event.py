"""匿名登录事件模型 – 匿名用户的登录信息与会话生命周期记录。

刻意不加 ``users`` 外键：匿名账号到期会被物理清除，而事件需要在此之后继续
保留用于统计与审计。代价是外键完整性由应用层保证。
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class GuestEventType(str, enum.Enum):
    """匿名会话事件类型（固定枚举，不接受任意字符串）。"""

    LOGIN = "login"
    LOGOUT = "logout"
    SESSION_END = "session_end"
    PURGE = "purge"
    BLOCKED = "blocked"


class GuestEvent(Base):
    """一条匿名用户事件。

    仅记录元数据：IP、User-Agent、存活时长、笔记数量。
    ``detail`` 只允许写入固定枚举值，禁止包含任何用户内容。
    """

    __tablename__ = "guest_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    # 匿名账号 ID；无外键，账号清除后事件仍保留
    guest_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False, index=True,
    )
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # IPv6 最长 45 字符
    ip_address: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    event_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    # 会话存活时长（秒）；logout / session_end / purge 时记录
    session_duration_seconds: Mapped[int | None] = mapped_column(Integer)
    # 清除时的笔记数量，仅数量不涉及内容
    note_count_at_end: Mapped[int | None] = mapped_column(Integer)
    # 固定枚举值，绝不写入用户内容
    detail: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
