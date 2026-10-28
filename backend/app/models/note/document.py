"""文档笔记附件模型：一条笔记最多对应一个原文件。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class NoteDocument(Base):
    """笔记原文件元数据；原文件字节落在 uploads/documents 下。"""

    __tablename__ = "note_documents"

    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("note_notes.id", ondelete="CASCADE"),
        primary_key=True,
    )
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime: Mapped[str] = mapped_column(String(120), nullable=False)
    ext: Mapped[str] = mapped_column(String(16), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    page_count: Mapped[int | None] = mapped_column(Integer)
    etag: Mapped[str] = mapped_column(String(80), nullable=False)
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    extract_status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    extract_error: Mapped[str | None] = mapped_column(Text)
    # 大字段：列表/元数据查询一律不能隐式加载
    extracted_text: Mapped[str | None] = mapped_column(Text, deferred=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    __table_args__ = (
        Index("ix_note_documents_sha256", "sha256"),
        Index("ix_note_documents_extract_status", "extract_status"),
    )
