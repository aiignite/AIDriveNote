"""Performance indexes for note list / folder tree queries."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "007_note_perf_indexes"
down_revision = "006_ai_attachments"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 笔记列表主查询: WHERE is_deleted=false AND created_by=:u ORDER BY is_pinned DESC, updated_at DESC
    op.create_index(
        "ix_note_notes_created_by_is_deleted_updated",
        "note_notes",
        ["created_by", "is_deleted", "updated_at"],
    )
    # 回收站/软删过滤 + 文件夹树
    op.create_index("ix_note_folders_parent_id", "note_folders", ["parent_id"])
    op.create_index(
        "ix_note_folders_user_id_is_deleted", "note_folders", ["user_id", "is_deleted"],
    )


def downgrade() -> None:
    op.drop_index("ix_note_folders_user_id_is_deleted", table_name="note_folders")
    op.drop_index("ix_note_folders_parent_id", table_name="note_folders")
    op.drop_index(
        "ix_note_notes_created_by_is_deleted_updated", table_name="note_notes",
    )
