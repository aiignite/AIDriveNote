"""Note Management models – 笔记管理，支持富文本、Markdown、思维导图、流程图."""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import String, Text, ForeignKey, DateTime, Boolean, func, Integer, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID, JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class NoteFolder(Base):
    """笔记文件夹."""

    __tablename__ = "note_folders"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_folders.id", ondelete="CASCADE"),
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    notes: Mapped[list[Note]] = relationship("Note", back_populates="folder_rel")
    children: Mapped[list[NoteFolder]] = relationship(
        "NoteFolder", back_populates="parent_rel",
    )
    parent_rel: Mapped[NoteFolder | None] = relationship(
        "NoteFolder", back_populates="children", remote_side=[id],
    )


class Note(Base):
    """笔记主表."""

    __tablename__ = "note_notes"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    note_no: Mapped[str] = mapped_column(
        String(50), unique=True, nullable=False, index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    note_type: Mapped[str] = mapped_column(
        String(20), nullable=False, index=True,
    )
    content: Mapped[dict | None] = mapped_column(JSONB)

    folder_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_folders.id", ondelete="SET NULL"),
        index=True,
    )

    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="Active")
    is_pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    search_text: Mapped[str | None] = mapped_column(Text)
    search_vector: Mapped[str | None] = mapped_column(TSVECTOR)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    folder_rel: Mapped[NoteFolder | None] = relationship(
        "NoteFolder", back_populates="notes",
    )
    tag_links: Mapped[list[NoteNoteTag]] = relationship(
        "NoteNoteTag", back_populates="note_rel", cascade="all, delete-orphan",
    )
    favorites: Mapped[list[NoteFavorite]] = relationship(
        "NoteFavorite", back_populates="note_rel", cascade="all, delete-orphan",
    )
    outgoing_links: Mapped[list[NoteLink]] = relationship(
        "NoteLink", foreign_keys="NoteLink.source_id", back_populates="source_rel",
        cascade="all, delete-orphan",
    )
    revisions: Mapped[list[NoteRevision]] = relationship(
        "NoteRevision", back_populates="note_rel", cascade="all, delete-orphan",
    )
    shares: Mapped[list[NoteShare]] = relationship(
        "NoteShare", back_populates="note_rel", cascade="all, delete-orphan",
    )


class NoteTemplate(Base):
    """笔记模板."""

    __tablename__ = "note_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    note_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text)
    content: Mapped[dict | None] = mapped_column(JSONB)
    thumbnail: Mapped[str | None] = mapped_column(String(500))
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True,
    )

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )


class NoteTag(Base):
    """用户笔记标签."""

    __tablename__ = "note_tags"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    color: Mapped[str] = mapped_column(String(20), default="#6b7280")
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )

    note_links: Mapped[list[NoteNoteTag]] = relationship(
        "NoteNoteTag", back_populates="tag_rel", cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_note_tags_user_id_name"),
    )


class NoteNoteTag(Base):
    """笔记-标签关联."""

    __tablename__ = "note_note_tags"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    tag_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_tags.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )

    note_rel: Mapped[Note] = relationship("Note", back_populates="tag_links")
    tag_rel: Mapped[NoteTag] = relationship("NoteTag", back_populates="note_links")

    __table_args__ = (
        UniqueConstraint("note_id", "tag_id", name="uq_note_note_tags_note_id_tag_id"),
    )


class NoteFavorite(Base):
    """用户收藏笔记."""

    __tablename__ = "note_note_favorites"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )

    note_rel: Mapped[Note] = relationship("Note", back_populates="favorites")

    __table_args__ = (
        UniqueConstraint("user_id", "note_id", name="uq_note_note_favorites_user_id_note_id"),
    )


class NoteLink(Base):
    """笔记双向链接."""

    __tablename__ = "note_links"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    source_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    target_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    link_text: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )

    source_rel: Mapped[Note] = relationship(
        "Note", foreign_keys=[source_id], back_populates="outgoing_links",
    )

    __table_args__ = (
        UniqueConstraint(
            "source_id", "target_id", "link_text",
            name="uq_note_links_source_id_target_id_link_text",
        ),
    )


class NoteRevision(Base):
    """笔记版本历史."""

    __tablename__ = "note_revisions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    content_snapshot: Mapped[dict | None] = mapped_column(JSONB)
    description: Mapped[str | None] = mapped_column(Text)
    change_summary: Mapped[str | None] = mapped_column(String(500))
    changed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )

    note_rel: Mapped[Note] = relationship("Note", back_populates="revisions")


class NoteShare(Base):
    """笔记分享."""

    __tablename__ = "note_shares"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    note_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    shared_with_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    permission: Mapped[str] = mapped_column(String(20), default="view")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )

    note_rel: Mapped[Note] = relationship("Note", back_populates="shares")

    __table_args__ = (
        UniqueConstraint(
            "note_id", "shared_with_user_id",
            name="uq_note_shares_note_id_shared_with_user_id",
        ),
    )
