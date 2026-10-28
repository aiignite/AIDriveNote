"""公开只读分享链接表。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "018_public_links"
down_revision = "017_kb_assets"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "note_public_links",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("note_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("token", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_note_public_links_note_id", "note_public_links", ["note_id"])
    op.create_index("ix_note_public_links_token", "note_public_links", ["token"], unique=True)


def downgrade() -> None:
    op.drop_table("note_public_links")
