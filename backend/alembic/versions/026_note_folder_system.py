"""笔记文件夹增加系统标记：知识库根文件夹不可删除 / 移动。

Revision ID: 026_note_folder_system
Revises: 025_note_documents
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "026_note_folder_system"
down_revision = "025_note_documents"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "note_folders",
        sa.Column(
            "is_system",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade() -> None:
    op.drop_column("note_folders", "is_system")
