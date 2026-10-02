"""笔记录音与转写 ORM 模型。

用于富文本笔记中的「音频录音 / 上传 → 语音转写 → 大模型整理」功能：
录音原始文件仅存磁盘（``storage_path``），数据库只保留元数据、状态机与转写分段。
生命周期：``Uploaded`` → ``Transcribing`` → ``Transcribed`` | ``Failed``。
"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class NoteRecording(Base):
    """单条笔记录音记录。

    属性说明：
        note_id: 关联的笔记 id；可为空（先录音后归属笔记的场景）。
        user_id: 上传者（笔记归属人）。
        file_name: 展示用原始文件名。
        file_size: 文件字节数。
        duration_seconds: 音频时长（秒），ffprobe 探测，探测失败为 -1。
        mime_type: 音频 MIME 类型。
        storage_path: 相对 backend/ 的存储路径（唯一）。
        status: 转写状态机：Uploaded/Transcribing/Transcribed/Failed。
        progress_pct: 转写进度百分比（0-100）。
        language: 转写语言（如 zh）。
        model_size: 使用的 Whisper 模型规格。
        error_message: 失败原因。
        is_deleted: 软删除标记。
    """

    __tablename__ = "note_recordings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    note_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_notes.id", ondelete="CASCADE"),
        index=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    file_name: Mapped[str] = mapped_column(String(512), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    mime_type: Mapped[str | None] = mapped_column(String(128))
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(
        String(30), nullable=False, default="Uploaded", index=True,
    )
    progress_pct: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    language: Mapped[str | None] = mapped_column(String(16))
    model_size: Mapped[str | None] = mapped_column(String(32))
    error_message: Mapped[str | None] = mapped_column(Text)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    transcripts: Mapped[list[NoteTranscript]] = relationship(
        "NoteTranscript",
        back_populates="recording",
        cascade="all, delete-orphan",
        order_by="NoteTranscript.segment_index",
    )


class NoteTranscript(Base):
    """一条带时间戳的转写分段（Whisper 输出 + LLM 润色结果）。

    属性说明：
        recording_id: 所属录音 id。
        segment_index: 分段序号（用于稳定排序）。
        start_time/end_time: 分段起止时间（秒）。
        speaker_label: 说话人标签（说话人分离开启时才有值）。
        text: 分段正文（润色后为简体、含标点）。
        confidence: 置信度（0-1）。
        language: 该分段语言。
        chapter_id/chapter_title: 章节序号与标题。
        keywords: 关键词列表。
        is_deleted: 软删除标记。
    """

    __tablename__ = "note_transcripts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4,
    )
    recording_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("note_recordings.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    segment_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    start_time: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    end_time: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    speaker_label: Mapped[str | None] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    confidence: Mapped[float | None] = mapped_column(Float)
    language: Mapped[str | None] = mapped_column(String(16))
    chapter_id: Mapped[int | None] = mapped_column(Integer)
    chapter_title: Mapped[str | None] = mapped_column(String(128))
    keywords: Mapped[list[str] | None] = mapped_column(JSONB)
    is_deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    recording: Mapped[NoteRecording] = relationship(
        "NoteRecording", back_populates="transcripts",
    )