"""文档笔记：note_type 增加 document，新增 note_documents 与原文保留字段。

Revision ID: 025_note_documents
Revises: 024_knowledge_distill_model
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "025_note_documents"
down_revision = "024_knowledge_distill_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. 放宽 note_type 取值约束
    op.execute("ALTER TABLE note_notes DROP CONSTRAINT IF EXISTS ck_note_notes_note_type")
    op.create_check_constraint(
        "ck_note_notes_note_type",
        "note_notes",
        "note_type IN ('rich_text', 'markdown', 'mindmap', 'flowchart', 'document')",
    )

    # 2. 文档笔记原文件元数据
    op.create_table(
        "note_documents",
        sa.Column(
            "note_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("note_notes.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("file_name", sa.String(length=255), nullable=False),
        sa.Column("mime", sa.String(length=120), nullable=False),
        sa.Column("ext", sa.String(length=16), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("storage_path", sa.String(length=512), nullable=False),
        sa.Column("page_count", sa.Integer(), nullable=True),
        sa.Column("etag", sa.String(length=80), nullable=False),
        sa.Column(
            "meta",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("extract_status", sa.String(length=20), nullable=False, server_default="pending"),
        sa.Column("extract_error", sa.Text(), nullable=True),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_note_documents_sha256", "note_documents", ["sha256"])
    op.create_index("ix_note_documents_extract_status", "note_documents", ["extract_status"])

    # 3. KB 资产保留原文件
    op.add_column("kb_files", sa.Column("storage_path", sa.String(length=512), nullable=True))

    # 4. 知识入库保留原文件并关联文档笔记
    op.add_column("ingest_documents", sa.Column("storage_path", sa.String(length=512), nullable=True))
    op.add_column(
        "ingest_documents",
        sa.Column("document_note_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_ingest_documents_document_note_id",
        "ingest_documents",
        "note_notes",
        ["document_note_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_ingest_documents_document_note_id", "ingest_documents", ["document_note_id"],
    )


def downgrade() -> None:
    """回滚会丢失所有文档笔记（原文件字节保留在磁盘上，但不再有引用）。"""
    op.drop_index("ix_ingest_documents_document_note_id", table_name="ingest_documents")
    op.drop_constraint(
        "fk_ingest_documents_document_note_id", "ingest_documents", type_="foreignkey",
    )
    op.drop_column("ingest_documents", "document_note_id")
    op.drop_column("ingest_documents", "storage_path")
    op.drop_column("kb_files", "storage_path")

    op.drop_index("ix_note_documents_extract_status", table_name="note_documents")
    op.drop_index("ix_note_documents_sha256", table_name="note_documents")
    op.drop_table("note_documents")

    op.execute("DELETE FROM note_notes WHERE note_type = 'document'")
    op.execute("ALTER TABLE note_notes DROP CONSTRAINT IF EXISTS ck_note_notes_note_type")
    op.create_check_constraint(
        "ck_note_notes_note_type",
        "note_notes",
        "note_type IN ('rich_text', 'markdown', 'mindmap', 'flowchart')",
    )
