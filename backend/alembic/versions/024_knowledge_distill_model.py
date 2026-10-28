"""知识蒸馏：用户选择模型。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "024_knowledge_distill_model"
down_revision = "023_knowledge_p2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_ai_settings",
        sa.Column("knowledge_distill_model", sa.String(255)),
    )


def downgrade() -> None:
    op.drop_column("user_ai_settings", "knowledge_distill_model")
