"""Add extended fields to ai_models."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "003_ai_model_extra"
down_revision = "002_ai_platform"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("ai_models", sa.Column("popularity", sa.Integer(), server_default="50", nullable=True))
    op.add_column("ai_models", sa.Column("speed", sa.String(50), server_default="Fast", nullable=True))
    op.add_column("ai_models", sa.Column("cost", sa.String(50), server_default="$", nullable=True))
    op.add_column("ai_models", sa.Column("context", sa.String(50), server_default="128K", nullable=True))
    op.add_column("ai_models", sa.Column("supports_text", sa.Boolean(), server_default="true", nullable=True))
    op.add_column("ai_models", sa.Column("supports_image", sa.Boolean(), server_default="false", nullable=True))


def downgrade() -> None:
    op.drop_column("ai_models", "supports_image")
    op.drop_column("ai_models", "supports_text")
    op.drop_column("ai_models", "context")
    op.drop_column("ai_models", "cost")
    op.drop_column("ai_models", "speed")
    op.drop_column("ai_models", "popularity")
