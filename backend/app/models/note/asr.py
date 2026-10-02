"""语音转写（ASR）配置与常用词库 ORM 模型。

``note_asr_settings`` 为全局单行配置表（对齐 AIDriveMeeting 的会议版设计），
环境变量 ``NOTE_ASR_*`` / ``NOTE_WHISPER_*`` 作为记录缺失时的兜底默认值。
``note_common_terms`` 为全局常用词库，在转写润色与 AI 整理时注入提示词。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class NoteAsrSettings(Base):
    """语音转写引擎的全局单行配置。

    属性说明：
        mode: 转写模式，``local``（本机 faster-whisper）或 ``remote``（局域网 GPU 网关）。
        remote_url: 远程 ASR 网关端点。
        remote_api_key: 远程网关鉴权密钥（加密落库）。
        remote_timeout_seconds: 远程转写最大等待秒数。
        model: Whisper 模型规格（tiny/base/small/medium/large-v3）。
        language: 语言代码；空串表示自动检测。
        device: 本机模式计算设备（cpu/cuda）。
        compute_type: 本机模式量化类型（int8/float16）。
        fallback_to_local: 远程失败时是否降级到本机转写。
        is_deleted: 软删除标记。
        created_by/updated_by: 操作者展示名。
    """

    __tablename__ = "note_asr_settings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    mode: Mapped[str] = mapped_column(String(16), nullable=False, default="local")
    remote_url: Mapped[str | None] = mapped_column(String(1024))
    remote_api_key: Mapped[str | None] = mapped_column(String(2048))
    remote_timeout_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=3600)
    model: Mapped[str] = mapped_column(String(32), nullable=False, default="medium")
    language: Mapped[str] = mapped_column(String(16), nullable=False, default="zh")
    device: Mapped[str] = mapped_column(String(16), nullable=False, default="cpu")
    compute_type: Mapped[str] = mapped_column(String(16), nullable=False, default="int8")
    fallback_to_local: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )
    created_by: Mapped[str | None] = mapped_column(String(128))
    updated_by: Mapped[str | None] = mapped_column(String(128))


class NoteCommonTerm(Base):
    """常用词库词条：用户维护的领域词汇（含同音/易错写法）。

    属性说明：
        term: 正确写法词条。
        alias: 同音/易错写法提示，逗号分隔。
        remark: 备注说明。
        is_enabled: 是否启用。
        usage_count: 被引用的次数统计。
        is_deleted: 软删除标记。
        created_by: 创建者展示名。
    """

    __tablename__ = "note_common_terms"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    term: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    alias: Mapped[str | None] = mapped_column(String(255))
    remark: Mapped[str | None] = mapped_column(Text)
    is_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    usage_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now(),
    )
    created_by: Mapped[str | None] = mapped_column(String(128))