"""RAG chunk 元数据索引：按来源/知识类型过滤。

rag_chunks 由 015 迁移或启动兜底创建；pgvector 不可用时本迁移跳过。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "022_rag_chunk_meta"
down_revision = "021_knowledge_ingest"
branch_labels = None
depends_on = None


def _rag_ready() -> bool:
    return bool(
        op.get_bind().execute(sa.text("SELECT to_regclass('public.rag_chunks')")).scalar()
    )


def upgrade() -> None:
    if not _rag_ready():
        print("[022_rag_chunk_meta] rag_chunks 不存在，跳过元数据索引")
        return
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_rag_chunks_meta "
        "ON rag_chunks USING gin (meta jsonb_path_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_rag_chunks_source "
        "ON rag_chunks ((meta->>'source_type'))"
    )


def downgrade() -> None:
    if not _rag_ready():
        return
    op.execute("DROP INDEX IF EXISTS ix_rag_chunks_source")
    op.execute("DROP INDEX IF EXISTS ix_rag_chunks_meta")
