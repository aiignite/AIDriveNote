"""笔记录音/语音转写表 – 录音、转写分段、ASR 设置、常用词库。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "009_note_recordings"
down_revision = "008_user_api_tokens"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 录音主表 ──
    op.create_table(
        "note_recordings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "note_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_notes.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("file_name", sa.String(512), nullable=False),
        sa.Column("file_size", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("mime_type", sa.String(128), nullable=True),
        sa.Column("storage_path", sa.String(1024), nullable=False),
        sa.Column(
            "status", sa.String(30), nullable=False, server_default=sa.text("'Uploaded'"),
        ),
        sa.Column("progress_pct", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("language", sa.String(16), nullable=True),
        sa.Column("model_size", sa.String(32), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column(
            "is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
    )
    op.create_index("ix_note_recordings_note_id", "note_recordings", ["note_id"])
    op.create_index("ix_note_recordings_user_id", "note_recordings", ["user_id"])
    op.create_index("ix_note_recordings_status", "note_recordings", ["status"])
    op.create_index(
        "ix_note_recordings_storage_path", "note_recordings", ["storage_path"], unique=True,
    )

    # ── 转写分段表 ──
    op.create_table(
        "note_transcripts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "recording_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_recordings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("segment_index", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("start_time", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("end_time", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("speaker_label", sa.String(64), nullable=True),
        sa.Column("text", sa.Text(), nullable=False, server_default=sa.text("''")),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("language", sa.String(16), nullable=True),
        sa.Column("chapter_id", sa.Integer(), nullable=True),
        sa.Column("chapter_title", sa.String(128), nullable=True),
        sa.Column("keywords", postgresql.JSONB(), nullable=True),
        sa.Column(
            "is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
    )
    op.create_index("ix_note_transcripts_recording_id", "note_transcripts", ["recording_id"])

    # ── ASR 全局设置表（单行）──
    op.create_table(
        "note_asr_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("mode", sa.String(16), nullable=False, server_default=sa.text("'local'")),
        sa.Column("remote_url", sa.String(1024), nullable=True),
        sa.Column("remote_api_key", sa.String(2048), nullable=True),
        sa.Column(
            "remote_timeout_seconds", sa.Integer(), nullable=False, server_default=sa.text("3600"),
        ),
        sa.Column("model", sa.String(32), nullable=False, server_default=sa.text("'medium'")),
        sa.Column("language", sa.String(16), nullable=False, server_default=sa.text("'zh'")),
        sa.Column("device", sa.String(16), nullable=False, server_default=sa.text("'cpu'")),
        sa.Column(
            "compute_type", sa.String(16), nullable=False, server_default=sa.text("'int8'"),
        ),
        sa.Column(
            "fallback_to_local", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column("created_by", sa.String(128), nullable=True),
        sa.Column("updated_by", sa.String(128), nullable=True),
    )

    # ── 常用词库表 ──
    op.create_table(
        "note_common_terms",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("term", sa.String(64), nullable=False),
        sa.Column("alias", sa.String(255), nullable=True),
        sa.Column("remark", sa.Text(), nullable=True),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("usage_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "is_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            server_default=sa.func.now(), nullable=False,
        ),
        sa.Column("created_by", sa.String(128), nullable=True),
    )
    op.create_index("ix_note_common_terms_term", "note_common_terms", ["term"])


def downgrade() -> None:
    op.drop_index("ix_note_common_terms_term", table_name="note_common_terms")
    op.drop_table("note_common_terms")
    op.drop_table("note_asr_settings")
    op.drop_index("ix_note_transcripts_recording_id", table_name="note_transcripts")
    op.drop_table("note_transcripts")
    op.drop_index("ix_note_recordings_storage_path", table_name="note_recordings")
    op.drop_index("ix_note_recordings_status", table_name="note_recordings")
    op.drop_index("ix_note_recordings_user_id", table_name="note_recordings")
    op.drop_index("ix_note_recordings_note_id", table_name="note_recordings")
    op.drop_table("note_recordings")