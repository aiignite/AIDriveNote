"""AI skill extra_config + note content_embedding for semantic RAG."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "005_ai_skill_extra_note_embedding"
down_revision = "004_user_role"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_skills",
        sa.Column("extra_config", JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.add_column(
        "note_notes",
        sa.Column("content_embedding", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("note_notes", "content_embedding")
    op.drop_column("ai_skills", "extra_config")
