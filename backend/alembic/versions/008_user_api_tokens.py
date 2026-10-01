"""个人访问令牌表 – 支持外部 Agent（MCP）以用户身份调用 REST API。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "008_user_api_tokens"
down_revision = "007_note_perf_indexes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_api_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("token_prefix", sa.String(16), nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "is_revoked", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # 用户维度的列表查询
    op.create_index("ix_user_api_tokens_user_id", "user_api_tokens", ["user_id"])
    # 认证时按摘要直查，唯一索引同时起到防重作用
    op.create_index(
        "ix_user_api_tokens_token_hash", "user_api_tokens", ["token_hash"], unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_user_api_tokens_token_hash", table_name="user_api_tokens")
    op.drop_index("ix_user_api_tokens_user_id", table_name="user_api_tokens")
    op.drop_table("user_api_tokens")