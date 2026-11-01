"""AI 技能与页面绑定增加用户归属，支持匿名自定义技能。

Revision ID: 027_skill_ownership
Revises: 026_note_folder_system
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "027_skill_ownership"
down_revision = "026_note_folder_system"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ai_skills",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_ai_skills_user_id_users",
        "ai_skills",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index("ix_ai_skills_user_id", "ai_skills", ["user_id"])

    op.add_column(
        "ai_page_skill_bindings",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_ai_page_skill_bindings_user_id_users",
        "ai_page_skill_bindings",
        "users",
        ["user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "ix_ai_page_skill_bindings_user_id",
        "ai_page_skill_bindings",
        ["user_id"],
    )

    # 旧的全局唯一约束：技能 code 全局唯一、页面绑定 (page_name, skill_id) 全局唯一
    op.execute("ALTER TABLE ai_skills DROP CONSTRAINT IF EXISTS ai_skills_code_key")
    op.execute("DROP INDEX IF EXISTS ai_skills_code_key")
    op.execute(
        "ALTER TABLE ai_page_skill_bindings "
        "DROP CONSTRAINT IF EXISTS uq_ai_page_skill_bindings"
    )

    # 系统命名空间（user_id IS NULL）与用户命名空间分别唯一；软删后允许复用 code
    op.create_index(
        "uq_ai_skills_system_code",
        "ai_skills",
        ["code"],
        unique=True,
        postgresql_where=sa.text("user_id IS NULL AND is_deleted = false"),
    )
    op.create_index(
        "uq_ai_skills_user_code",
        "ai_skills",
        ["user_id", "code"],
        unique=True,
        postgresql_where=sa.text("user_id IS NOT NULL AND is_deleted = false"),
    )
    op.create_index(
        "uq_ai_page_skill_bindings_system",
        "ai_page_skill_bindings",
        ["page_name", "skill_id"],
        unique=True,
        postgresql_where=sa.text("user_id IS NULL AND is_deleted = false"),
    )
    op.create_index(
        "uq_ai_page_skill_bindings_user",
        "ai_page_skill_bindings",
        ["user_id", "page_name", "skill_id"],
        unique=True,
        postgresql_where=sa.text("user_id IS NOT NULL AND is_deleted = false"),
    )


def downgrade() -> None:
    op.drop_index("uq_ai_page_skill_bindings_user", table_name="ai_page_skill_bindings")
    op.drop_index("uq_ai_page_skill_bindings_system", table_name="ai_page_skill_bindings")
    op.drop_index("uq_ai_skills_user_code", table_name="ai_skills")
    op.drop_index("uq_ai_skills_system_code", table_name="ai_skills")

    # 旧 schema 无法表达用户归属；降级会丢弃用户自定义技能与覆盖绑定
    op.execute("DELETE FROM ai_page_skill_bindings WHERE user_id IS NOT NULL")
    op.execute("DELETE FROM ai_skills WHERE user_id IS NOT NULL")

    op.drop_index("ix_ai_page_skill_bindings_user_id", table_name="ai_page_skill_bindings")
    op.drop_constraint(
        "fk_ai_page_skill_bindings_user_id_users",
        "ai_page_skill_bindings",
        type_="foreignkey",
    )
    op.drop_column("ai_page_skill_bindings", "user_id")

    op.drop_index("ix_ai_skills_user_id", table_name="ai_skills")
    op.drop_constraint("fk_ai_skills_user_id_users", "ai_skills", type_="foreignkey")
    op.drop_column("ai_skills", "user_id")

    op.create_unique_constraint("ai_skills_code_key", "ai_skills", ["code"])
    op.create_unique_constraint(
        "uq_ai_page_skill_bindings",
        "ai_page_skill_bindings",
        ["page_name", "skill_id"],
    )
