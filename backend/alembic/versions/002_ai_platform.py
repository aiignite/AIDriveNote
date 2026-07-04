"""AI platform tables for AIDriveNote."""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "002_ai_platform"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "ai_models",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("model_id", sa.String(255), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("endpoint", sa.String(255)),
        sa.Column("api_key", sa.Text()),
        sa.Column("description", sa.Text()),
        sa.Column("is_public", sa.Boolean(), server_default="true"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_ai_models_name", "ai_models", ["name"])

    op.create_table(
        "ai_assistants",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("avatar", sa.String(32)),
        sa.Column("role", sa.String(100)),
        sa.Column("category", sa.String(100)),
        sa.Column("system_prompt", sa.Text(), nullable=False),
        sa.Column("model", sa.String(255)),
        sa.Column("temperature", sa.Float(), server_default="0.4"),
        sa.Column("max_tokens", sa.Integer(), server_default="16384"),
        sa.Column("is_system", sa.Boolean(), server_default="false"),
        sa.Column("is_default", sa.Boolean(), server_default="false"),
        sa.Column("tools", postgresql.JSONB(), server_default="[]"),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_ai_assistants_name", "ai_assistants", ["name"])

    op.create_table(
        "ai_conversations",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(255)),
        sa.Column("assistant_name", sa.String(255)),
        sa.Column("model", sa.String(255)),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_ai_conversations_user_id", "ai_conversations", ["user_id"])

    op.create_table(
        "ai_messages",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("conversation_id", UUID, sa.ForeignKey("ai_conversations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(50), nullable=False),
        sa.Column("content", sa.Text(), server_default=""),
        sa.Column("tool_calls", postgresql.JSONB(), server_default="[]"),
        sa.Column("tool_results", postgresql.JSONB(), server_default="[]"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_ai_messages_conversation_id", "ai_messages", ["conversation_id"])

    op.create_table(
        "user_ai_settings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True),
        sa.Column("default_model_name", sa.String(255)),
        sa.Column("default_provider", sa.String(50)),
        sa.Column("sidebar_width", sa.Integer(), server_default="400"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        "ai_skills",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("code", sa.String(100), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("prompt_template", sa.Text(), server_default=""),
        sa.Column("tool_names", postgresql.JSONB(), server_default="[]"),
        sa.Column("keywords", postgresql.JSONB(), server_default="[]"),
        sa.Column("priority", sa.Integer(), server_default="50"),
        sa.Column("is_enabled", sa.Boolean(), server_default="true"),
        sa.Column("is_builtin", sa.Boolean(), server_default="false"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )

    op.create_table(
        "ai_assistant_skill_bindings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("assistant_id", UUID, sa.ForeignKey("ai_assistants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("skill_id", UUID, sa.ForeignKey("ai_skills.id", ondelete="CASCADE"), nullable=False),
        sa.Column("weight", sa.Integer(), server_default="50"),
        sa.Column("is_enabled", sa.Boolean(), server_default="true"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("assistant_id", "skill_id", name="uq_ai_assistant_skill_bindings"),
    )

    op.create_table(
        "ai_page_skill_bindings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("page_name", sa.String(100), nullable=False),
        sa.Column("skill_id", UUID, sa.ForeignKey("ai_skills.id", ondelete="CASCADE"), nullable=False),
        sa.Column("weight", sa.Integer(), server_default="50"),
        sa.Column("is_enabled", sa.Boolean(), server_default="true"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("page_name", "skill_id", name="uq_ai_page_skill_bindings"),
    )


def downgrade() -> None:
    op.drop_table("ai_page_skill_bindings")
    op.drop_table("ai_assistant_skill_bindings")
    op.drop_table("ai_skills")
    op.drop_table("user_ai_settings")
    op.drop_table("ai_messages")
    op.drop_table("ai_conversations")
    op.drop_table("ai_assistants")
    op.drop_table("ai_models")
