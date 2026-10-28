"""访问令牌权限范围（read / write / ask）。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "019_token_scopes"
down_revision = "018_public_links"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "user_api_tokens",
        sa.Column("scopes", sa.String(100), nullable=False, server_default="read,write"),
    )


def downgrade() -> None:
    op.drop_column("user_api_tokens", "scopes")
