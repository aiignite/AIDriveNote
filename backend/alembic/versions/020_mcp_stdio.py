"""MCP stdio 传输：服务器命令、参数与调用审计。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "020_mcp_stdio"
down_revision = "019_token_scopes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("mcp_servers", sa.Column("command", sa.String(500)))
    op.add_column(
        "mcp_servers",
        sa.Column("args", postgresql.JSONB(), server_default="[]", nullable=False),
    )
    op.alter_column("mcp_servers", "url", server_default="")


def downgrade() -> None:
    op.drop_column("mcp_servers", "args")
    op.drop_column("mcp_servers", "command")
