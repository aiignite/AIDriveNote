"""知识 P2：多卡 card_key、用户蒸馏设置、RAG 嵌入模型记录。"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "023_knowledge_p2"
down_revision = "022_rag_chunk_meta"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return bool(
        op.get_bind().execute(sa.text(f"SELECT to_regclass('public.{name}')")).scalar()
    )


def upgrade() -> None:
    op.add_column(
        "user_ai_settings",
        sa.Column("knowledge_distill_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
    )
    op.add_column(
        "user_ai_settings",
        sa.Column("knowledge_allow_external", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.add_column(
        "user_ai_settings",
        sa.Column("knowledge_daily_limit", sa.Integer(), server_default="100", nullable=False),
    )

    op.add_column(
        "knowledge_cards",
        sa.Column("card_key", sa.String(120), server_default="", nullable=False),
    )
    op.drop_constraint(
        "uq_knowledge_cards_document_version", "knowledge_cards", type_="unique",
    )
    op.create_unique_constraint(
        "uq_knowledge_cards_document_version_key",
        "knowledge_cards",
        ["document_id", "version", "card_key"],
    )

    if _has_table("rag_documents"):
        op.execute(
            "ALTER TABLE rag_documents "
            "ADD COLUMN IF NOT EXISTS embedding_model varchar(120)"
        )


def downgrade() -> None:
    if _has_table("rag_documents"):
        op.execute("ALTER TABLE rag_documents DROP COLUMN IF EXISTS embedding_model")
    op.drop_constraint(
        "uq_knowledge_cards_document_version_key", "knowledge_cards", type_="unique",
    )
    op.create_unique_constraint(
        "uq_knowledge_cards_document_version",
        "knowledge_cards",
        ["document_id", "version"],
    )
    op.drop_column("knowledge_cards", "card_key")
    op.drop_column("user_ai_settings", "knowledge_daily_limit")
    op.drop_column("user_ai_settings", "knowledge_allow_external")
    op.drop_column("user_ai_settings", "knowledge_distill_enabled")
