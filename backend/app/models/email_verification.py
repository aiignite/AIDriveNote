"""邮箱验证码表 – 注册等流程的邮件确认码。

参照 AIIgnitePLM 的 ``sys_email_verification_codes``：数据库存 SHA-256 摘要
而非明文，配合有效期、错误尝试计数与消费时间戳，避免明文泄露与无限暴力尝试。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class EmailVerificationCode(Base):
    __tablename__ = "email_verification_codes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    # 用途隔离：register（后续可扩展 reset 等互不干扰）
    purpose: Mapped[str] = mapped_column(String(20), nullable=False, default="register", index=True)
    code_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    # 非空即已消费（被使用 / 被新码作废）；软删除保留记录便于审计
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
