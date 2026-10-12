"""Independent user model for AIDriveNote."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    role: Mapped[str] = mapped_column(String(20), default="user", server_default="'user'")
    status: Mapped[str] = mapped_column(String(30), default="Active")
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    # 匿名登录账号标记：每次点「匿名登录」新建一条独立账号（笔记按 created_by 隔离，
    # 共用账号会导致匿名用户互相可见）。role 固定为 guest，数据到期后物理清除。
    is_guest: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # 最后一次请求时间，「离线宽限期」的计时基准；由 auth 依赖节流刷新
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 清除完成标记，保证清除任务幂等（账号行异常残留时后续扫描会跳过）
    guest_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )
