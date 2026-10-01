"""个人访问令牌模型 – 供外部 Agent（MCP）以用户身份调用 REST API。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class UserApiToken(Base):
    """用户个人访问令牌（PAT）。

    明文令牌只在签发响应中返回一次，数据库仅保存 SHA-256 摘要，
    因此即使数据泄露也无法还原出可用令牌。
    撤销采用软删除（is_revoked），保留审计痕迹。
    """

    __tablename__ = "user_api_tokens"

    # 主键
    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    # 所属用户；用户被删除时级联清除其令牌
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 用户可读的令牌名称，用于区分不同客户端（如「Claude Desktop」）
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # 令牌 SHA-256 摘要（hex），唯一索引供认证时直接命中
    token_hash: Mapped[str] = mapped_column(
        String(64), nullable=False, unique=True, index=True,
    )
    # 令牌展示前缀（adn_ + 前 8 位），列表页用于辨识
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    # 最近一次使用时间，用于识别长期未用的僵尸令牌
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    # 过期时间；NULL 表示长期有效
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True,
    )
    # 是否已撤销（软删除）
    is_revoked: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false",
    )
    # 创建时间
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )