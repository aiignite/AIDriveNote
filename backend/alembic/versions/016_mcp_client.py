"""MCP 客户端表：服务器 / 工具缓存 / 调用审计。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "016_mcp_client"
down_revision = "015_rag_v2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "mcp_servers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("transport", sa.String(20), server_default="http"),
        sa.Column("url", sa.String(500), nullable=False),
        sa.Column("headers_enc", sa.Text()),
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_mcp_servers_user_id", "mcp_servers", ["user_id"])

    op.create_table(
        "mcp_server_tools",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("server_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("input_schema", postgresql.JSONB(), server_default="{}"),
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.false()),
        sa.Column("approval_policy", sa.String(20), server_default="ask"),
        sa.Column("discovered_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("server_id", "name", name="uq_mcp_server_tools_server_id_name"),
    )
    op.create_index("ix_mcp_server_tools_server_id", "mcp_server_tools", ["server_id"])

    op.create_table(
        "mcp_call_audit",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("server_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tool_name", sa.String(200), nullable=False),
        sa.Column("arguments", postgresql.JSONB(), server_default="{}"),
        sa.Column("status", sa.String(20), server_default="ok"),
        sa.Column("error", sa.Text()),
        sa.Column("duration_ms", sa.Integer(), server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_mcp_call_audit_user_id", "mcp_call_audit", ["user_id"])


def downgrade() -> None:
    op.drop_table("mcp_call_audit")
    op.drop_table("mcp_server_tools")
    op.drop_table("mcp_servers")
