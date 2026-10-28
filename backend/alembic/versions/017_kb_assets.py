"""知识库资产表：根目录与文件清单。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "017_kb_assets"
down_revision = "016_mcp_client"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "kb_roots",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("folder_id", postgresql.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_kb_roots_user_id", "kb_roots", ["user_id"])

    op.create_table(
        "kb_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("root_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("kb_roots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("path", sa.Text(), nullable=False),
        sa.Column("mime", sa.String(120)),
        sa.Column("size", sa.Integer(), server_default="0"),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("extracted_text", sa.Text()),
        sa.Column("status", sa.String(20), server_default="pending"),
        sa.Column("is_protected", sa.Boolean(), server_default=sa.false()),
        sa.Column("note_id", postgresql.UUID(as_uuid=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("root_id", "path", name="uq_kb_files_root_id_path"),
    )
    op.create_index("ix_kb_files_root_id", "kb_files", ["root_id"])
    op.create_index("ix_kb_files_user_id", "kb_files", ["user_id"])


def downgrade() -> None:
    op.drop_table("kb_files")
    op.drop_table("kb_roots")
