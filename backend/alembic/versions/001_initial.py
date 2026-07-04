"""Initial schema: users + 9 note tables for AIDriveNote."""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

UUID = postgresql.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("status", sa.String(30), server_default="'Active'"),
        sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "note_folders",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("parent_id", UUID, sa.ForeignKey("note_folders.id", ondelete="CASCADE")),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_note_folders_user_id", "note_folders", ["user_id"])

    op.create_table(
        "note_notes",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_no", sa.String(50), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("note_type", sa.String(20), nullable=False),
        sa.Column("content", postgresql.JSONB()),
        sa.Column("folder_id", UUID, sa.ForeignKey("note_folders.id", ondelete="SET NULL")),
        sa.Column("description", sa.Text()),
        sa.Column("status", sa.String(30), server_default="'Active'"),
        sa.Column("is_pinned", sa.Boolean(), server_default="false"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("search_text", sa.Text()),
        sa.Column("search_vector", postgresql.TSVECTOR()),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("updated_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("note_no", name="uq_note_notes_note_no"),
    )
    op.create_index("ix_note_notes_note_no", "note_notes", ["note_no"], unique=True)
    op.create_index("ix_note_notes_note_type", "note_notes", ["note_type"])
    op.create_index("ix_note_notes_folder_id", "note_notes", ["folder_id"])
    op.create_index(
        "ix_note_notes_search_vector", "note_notes", ["search_vector"], postgresql_using="gin",
    )

    op.create_table(
        "note_templates",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("note_type", sa.String(20), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("content", postgresql.JSONB()),
        sa.Column("thumbnail", sa.String(500)),
        sa.Column("is_builtin", sa.Boolean(), server_default="false"),
        sa.Column("sort_order", sa.Integer(), server_default="0"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("updated_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_note_templates_note_type", "note_templates", ["note_type"])
    op.create_index("ix_note_templates_user_id", "note_templates", ["user_id"])

    op.create_table(
        "note_tags",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("color", sa.String(20), server_default="'#6b7280'"),
        sa.Column("is_deleted", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("user_id", "name", name="uq_note_tags_user_id_name"),
    )
    op.create_index("ix_note_tags_user_id", "note_tags", ["user_id"])

    op.create_table(
        "note_note_tags",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_id", UUID, sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tag_id", UUID, sa.ForeignKey("note_tags.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("note_id", "tag_id", name="uq_note_note_tags_note_id_tag_id"),
    )
    op.create_index("ix_note_note_tags_note_id", "note_note_tags", ["note_id"])
    op.create_index("ix_note_note_tags_tag_id", "note_note_tags", ["tag_id"])

    op.create_table(
        "note_note_favorites",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("note_id", UUID, sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("user_id", "note_id", name="uq_note_note_favorites_user_id_note_id"),
    )
    op.create_index("ix_note_note_favorites_user_id", "note_note_favorites", ["user_id"])
    op.create_index("ix_note_note_favorites_note_id", "note_note_favorites", ["note_id"])

    op.create_table(
        "note_links",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("source_id", UUID, sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("target_id", UUID, sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("link_text", sa.String(200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint(
            "source_id", "target_id", "link_text",
            name="uq_note_links_source_id_target_id_link_text",
        ),
    )
    op.create_index("ix_note_links_source_id", "note_links", ["source_id"])
    op.create_index("ix_note_links_target_id", "note_links", ["target_id"])

    op.create_table(
        "note_revisions",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_id", UUID, sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("content_snapshot", postgresql.JSONB()),
        sa.Column("description", sa.Text()),
        sa.Column("change_summary", sa.String(500)),
        sa.Column("changed_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    )
    op.create_index("ix_note_revisions_note_id", "note_revisions", ["note_id"])

    op.create_table(
        "note_shares",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("note_id", UUID, sa.ForeignKey("note_notes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("shared_with_user_id", UUID, sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("permission", sa.String(20), server_default="'view'"),
        sa.Column("created_by", UUID, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint(
            "note_id", "shared_with_user_id",
            name="uq_note_shares_note_id_shared_with_user_id",
        ),
    )
    op.create_index("ix_note_shares_note_id", "note_shares", ["note_id"])
    op.create_index("ix_note_shares_shared_with_user_id", "note_shares", ["shared_with_user_id"])


def downgrade() -> None:
    op.drop_table("note_shares")
    op.drop_table("note_revisions")
    op.drop_table("note_links")
    op.drop_table("note_note_favorites")
    op.drop_table("note_note_tags")
    op.drop_table("note_tags")
    op.drop_table("note_templates")
    op.drop_table("note_notes")
    op.drop_table("note_folders")
    op.drop_table("users")
