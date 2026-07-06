"""Add role column to users."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "004_user_role"
down_revision = "003_ai_model_extra"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("role", sa.String(20), server_default="'user'", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("users", "role")
