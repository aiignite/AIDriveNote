"""邮箱验证码表 – 注册需邮件确认码后才能完成。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "012_email_verification_codes"
down_revision = "011_note_encryption"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "email_verification_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("purpose", sa.String(20), nullable=False, server_default="register"),
        # 只存 SHA-256 摘要，不落明文
        sa.Column("code_hash", sa.String(128), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # 发码冷却 / 作废旧码按 email+purpose 维度查询
    op.create_index("ix_email_verification_codes_email", "email_verification_codes", ["email"])
    op.create_index("ix_email_verification_codes_purpose", "email_verification_codes", ["purpose"])
    # 有效期内有效码查询
    op.create_index("ix_email_verification_codes_expires_at", "email_verification_codes", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_email_verification_codes_expires_at", table_name="email_verification_codes")
    op.drop_index("ix_email_verification_codes_purpose", table_name="email_verification_codes")
    op.drop_index("ix_email_verification_codes_email", table_name="email_verification_codes")
    op.drop_table("email_verification_codes")
