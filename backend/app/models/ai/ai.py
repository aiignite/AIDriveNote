"""AI platform models for AIDriveNote."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class AIProvider(str, enum.Enum):
    OLLAMA = "OLLAMA"
    OPENAI = "OPENAI"
    ANTHROPIC = "ANTHROPIC"
    MINIMAX = "MINIMAX"


class AIModel(Base):
    __tablename__ = "ai_models"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)
    provider: Mapped[str] = mapped_column(String(50), nullable=False)
    endpoint: Mapped[str | None] = mapped_column(String(255))
    api_key: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    popularity: Mapped[int] = mapped_column(Integer, default=50)
    speed: Mapped[str] = mapped_column(String(50), default="Fast")
    cost: Mapped[str] = mapped_column(String(50), default="$")
    context: Mapped[str] = mapped_column(String(50), default="128K")
    supports_text: Mapped[bool] = mapped_column(Boolean, default=True)
    supports_image: Mapped[bool] = mapped_column(Boolean, default=False)
    is_public: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )


class AIAssistant(Base):
    __tablename__ = "ai_assistants"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    avatar: Mapped[str | None] = mapped_column(String(32))
    role: Mapped[str | None] = mapped_column(String(100))
    category: Mapped[str | None] = mapped_column(String(100))
    system_prompt: Mapped[str] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(255))
    temperature: Mapped[float | None] = mapped_column(Float, default=0.4)
    max_tokens: Mapped[int | None] = mapped_column(Integer, default=16384)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    tools: Mapped[list | None] = mapped_column(JSONB, default=list)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"),
    )
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    skill_bindings: Mapped[list[AIAssistantSkillBinding]] = relationship(
        "AIAssistantSkillBinding", back_populates="assistant", cascade="all, delete-orphan",
    )


class AIConversation(Base):
    __tablename__ = "ai_conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True,
    )
    title: Mapped[str | None] = mapped_column(String(255))
    assistant_name: Mapped[str | None] = mapped_column(String(255))
    model: Mapped[str | None] = mapped_column(String(255))
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    messages: Mapped[list[AIMessage]] = relationship(
        "AIMessage", back_populates="conversation", cascade="all, delete-orphan",
        order_by="AIMessage.created_at",
    )


class AIMessage(Base):
    __tablename__ = "ai_messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_conversations.id", ondelete="CASCADE"), index=True,
    )
    role: Mapped[str] = mapped_column(String(50))
    content: Mapped[str] = mapped_column(Text, default="")
    tool_calls: Mapped[list | None] = mapped_column(JSONB, default=list)
    tool_results: Mapped[list | None] = mapped_column(JSONB, default=list)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    conversation: Mapped[AIConversation] = relationship("AIConversation", back_populates="messages")


class UserAISettings(Base):
    __tablename__ = "user_ai_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), unique=True,
    )
    default_model_name: Mapped[str | None] = mapped_column(String(255))
    default_provider: Mapped[str | None] = mapped_column(String(50))
    sidebar_width: Mapped[int] = mapped_column(Integer, default=400)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )


class AISkill(Base):
    __tablename__ = "ai_skills"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    code: Mapped[str] = mapped_column(String(100), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    prompt_template: Mapped[str] = mapped_column(Text, default="")
    tool_names: Mapped[list] = mapped_column(JSONB, default=list)
    keywords: Mapped[list] = mapped_column(JSONB, default=list)
    priority: Mapped[int] = mapped_column(Integer, default=50)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(),
    )

    assistant_bindings: Mapped[list[AIAssistantSkillBinding]] = relationship(
        "AIAssistantSkillBinding", back_populates="skill", cascade="all, delete-orphan",
    )
    page_bindings: Mapped[list[PageSkillBinding]] = relationship(
        "PageSkillBinding", back_populates="skill", cascade="all, delete-orphan",
    )


class AIAssistantSkillBinding(Base):
    __tablename__ = "ai_assistant_skill_bindings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    assistant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_assistants.id", ondelete="CASCADE"),
    )
    skill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_skills.id", ondelete="CASCADE"),
    )
    weight: Mapped[int] = mapped_column(Integer, default=50)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    assistant: Mapped[AIAssistant] = relationship("AIAssistant", back_populates="skill_bindings")
    skill: Mapped[AISkill] = relationship("AISkill", back_populates="assistant_bindings")

    __table_args__ = (
        UniqueConstraint("assistant_id", "skill_id", name="uq_ai_assistant_skill_bindings"),
    )


class PageSkillBinding(Base):
    __tablename__ = "ai_page_skill_bindings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    page_name: Mapped[str] = mapped_column(String(100), nullable=False)
    skill_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ai_skills.id", ondelete="CASCADE"),
    )
    weight: Mapped[int] = mapped_column(Integer, default=50)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    skill: Mapped[AISkill] = relationship("AISkill", back_populates="page_bindings")

    __table_args__ = (
        UniqueConstraint("page_name", "skill_id", name="uq_ai_page_skill_bindings"),
    )
