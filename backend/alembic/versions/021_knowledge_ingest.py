"""知识入库：源文档、任务、知识卡与来源关系。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "021_knowledge_ingest"
down_revision = "020_mcp_stdio"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ingest_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("source_type", sa.String(20), nullable=False),
        sa.Column("external_id", sa.String(512), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("title", sa.Text()),
        sa.Column("url", sa.Text()),
        sa.Column("mime", sa.String(120)),
        sa.Column("occurred_at", sa.DateTime(timezone=True)),
        sa.Column("raw_text", sa.Text()),
        sa.Column("raw_meta", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("status", sa.String(20), server_default="received", nullable=False),
        sa.Column("parser", sa.String(40)),
        sa.Column("parse_meta", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("error", sa.Text()),
        sa.Column(
            "note_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_notes.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "kb_file_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("kb_files.id", ondelete="SET NULL"),
        ),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("parsed_at", sa.DateTime(timezone=True)),
        sa.Column("distilled_at", sa.DateTime(timezone=True)),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("compiled_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint(
            "user_id", "source_type", "external_id", "content_hash",
            name="uq_ingest_documents_source",
        ),
    )
    op.create_index("ix_ingest_documents_status", "ingest_documents", ["status", "received_at"])
    op.create_index("ix_ingest_documents_hash", "ingest_documents", ["user_id", "content_hash"])

    op.create_table(
        "ingest_jobs",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "document_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_documents.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("stage", sa.String(20), nullable=False),
        sa.Column("status", sa.String(20), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("error", sa.Text()),
    )
    op.create_index("ix_ingest_jobs_pending", "ingest_jobs", ["status", "scheduled_at"])
    op.create_index("ix_ingest_jobs_document", "ingest_jobs", ["document_id", "stage"])

    op.create_table(
        "knowledge_cards",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "document_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_documents.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("status", sa.String(20), server_default="pending_review", nullable=False),
        sa.Column("knowledge_type", sa.String(20), server_default="note", nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("summary", sa.Text(), nullable=False),
        sa.Column("confidence", sa.String(10), server_default="medium", nullable=False),
        sa.Column("payload", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column(
            "merge_target_note_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_notes.id", ondelete="SET NULL"),
        ),
        sa.Column("merge_score", sa.Float()),
        sa.Column(
            "note_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_notes.id", ondelete="SET NULL"),
        ),
        sa.Column("kb_target", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("extractor", sa.String(20), server_default="rule", nullable=False),
        sa.Column("model", sa.String(120)),
        sa.Column("prompt_version", sa.String(16)),
        sa.Column("input_tokens", sa.Integer()),
        sa.Column("output_tokens", sa.Integer()),
        sa.Column("decided_by", postgresql.UUID(as_uuid=True)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("document_id", "version", name="uq_knowledge_cards_document_version"),
    )
    op.create_index(
        "ix_knowledge_cards_inbox", "knowledge_cards",
        ["user_id", "status", "created_at"],
    )

    op.create_table(
        "note_sources",
        sa.Column(
            "note_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_notes.id", ondelete="CASCADE"), primary_key=True,
        ),
        sa.Column(
            "document_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ingest_documents.id", ondelete="CASCADE"), primary_key=True,
        ),
        sa.Column(
            "card_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("knowledge_cards.id", ondelete="SET NULL"),
        ),
        sa.Column("role", sa.String(20), server_default="primary", nullable=False),
    )


def downgrade() -> None:
    op.drop_table("note_sources")
    op.drop_table("knowledge_cards")
    op.drop_table("ingest_jobs")
    op.drop_table("ingest_documents")
