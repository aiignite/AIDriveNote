"""AI chat attachments."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "006_ai_attachments"
down_revision = "005_ai_skill_extra"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_attachments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "conversation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("ai_conversations.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(100), nullable=False),
        sa.Column("file_path", sa.String(512), nullable=False),
        sa.Column("purpose", sa.String(20), nullable=False, server_default="chat"),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_ai_attachments_user_id", "ai_attachments", ["user_id"])
    op.create_index("ix_ai_attachments_conversation_id", "ai_attachments", ["conversation_id"])
    op.add_column(
        "ai_messages",
        sa.Column("attachment_ids", JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
    )


def downgrade() -> None:
    op.drop_column("ai_messages", "attachment_ids")
    op.drop_index("ix_ai_attachments_conversation_id", table_name="ai_attachments")
    op.drop_index("ix_ai_attachments_user_id", table_name="ai_attachments")
    op.drop_table("ai_attachments")
