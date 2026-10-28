"""知识入库：源文档、解析/蒸馏任务、知识卡与来源关系。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base

# SQLite 没有 BIGSERIAL，测试库退化为 INTEGER 自增
_JOB_ID = BigInteger().with_variant(Integer, "sqlite")


class IngestDocument(Base):
    """外部来源文档：邮件、上传文件、剪藏、MCP 推送、自写笔记。"""

    __tablename__ = "ingest_documents"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    source_type: Mapped[str] = mapped_column(String(20), nullable=False)
    external_id: Mapped[str] = mapped_column(String(512), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    mime: Mapped[str | None] = mapped_column(String(120))
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_text: Mapped[str | None] = mapped_column(Text)
    raw_meta: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="received", nullable=False)
    parser: Mapped[str | None] = mapped_column(String(40))
    parse_meta: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    note_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="SET NULL"),
    )
    kb_file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("kb_files.id", ondelete="SET NULL"),
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    parsed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    distilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    compiled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint(
            "user_id", "source_type", "external_id", "content_hash",
            name="uq_ingest_documents_source",
        ),
        Index("ix_ingest_documents_status", "status", "received_at"),
        Index("ix_ingest_documents_hash", "user_id", "content_hash"),
    )


class IngestJob(Base):
    """解析 / 蒸馏两阶段任务；同文档同 stage 的 pending 任务会合并。"""

    __tablename__ = "ingest_jobs"

    id: Mapped[int] = mapped_column(_JOB_ID, primary_key=True, autoincrement=True)
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ingest_documents.id", ondelete="CASCADE"), nullable=False,
    )
    stage: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    scheduled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False,
    )
    error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        Index("ix_ingest_jobs_pending", "status", "scheduled_at"),
        Index("ix_ingest_jobs_document", "document_id", "stage"),
    )


class KnowledgeCard(Base):
    """蒸馏结果 + 审核状态；批准后才编译成 Note。"""

    __tablename__ = "knowledge_cards"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ingest_documents.id", ondelete="CASCADE"), nullable=False,
    )
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    card_key: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending_review", nullable=False)
    knowledge_type: Mapped[str] = mapped_column(String(20), default="note", nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    confidence: Mapped[str] = mapped_column(String(10), default="medium", nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    merge_target_note_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="SET NULL"),
    )
    merge_score: Mapped[float | None] = mapped_column()
    note_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="SET NULL"),
    )
    kb_target: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    extractor: Mapped[str] = mapped_column(String(20), default="rule", nullable=False)
    model: Mapped[str | None] = mapped_column(String(120))
    prompt_version: Mapped[str | None] = mapped_column(String(16))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "document_id", "version", "card_key",
            name="uq_knowledge_cards_document_version_key",
        ),
        Index("ix_knowledge_cards_inbox", "user_id", "status", "created_at"),
    )


class NoteSource(Base):
    """知识笔记与源文档的多对多来源关系。"""

    __tablename__ = "note_sources"

    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"), primary_key=True,
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ingest_documents.id", ondelete="CASCADE"), primary_key=True,
    )
    card_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("knowledge_cards.id", ondelete="SET NULL"),
    )
    role: Mapped[str] = mapped_column(String(20), default="primary", nullable=False)
