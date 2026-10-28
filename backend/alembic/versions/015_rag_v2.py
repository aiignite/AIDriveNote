"""RAG v2：pgvector 分块索引表。

说明：

- 这些表不由 ORM 声明（SQLite 测试库不支持 vector 类型），服务层用原生 SQL 访问。
- 本迁移负责生产库的建表/索引；应用启动时也会调用 ``ensure_rag_schema`` 做幂等兜底。
- 若部署未安装 pgvector 扩展，迁移会失败；此时设置 ``RAG_V2_ENABLED=false`` 并跳过本迁移，
  检索自动回退 v1（整篇向量 + JSONB 扫描）。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "015_rag_v2"
down_revision = "014_guest_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 部分部署（如 postgres:16-alpine）不含 pgvector：跳过 v2 表，
    # 应用启动时 ensure_rag_schema 会再次尝试；仍不可用则检索自动回退 v1。
    bind = op.get_bind()
    available = bind.execute(
        sa.text("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'")
    ).scalar()
    if not available:
        print("[015_rag_v2] pgvector 不可用，跳过 RAG v2 表；检索将回退 v1")
        return
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS rag_documents (
          note_id uuid PRIMARY KEY REFERENCES note_notes(id) ON DELETE CASCADE,
          user_id uuid NOT NULL,
          content_hash char(64) NOT NULL,
          chunk_count int NOT NULL DEFAULT 0,
          status varchar(20) NOT NULL DEFAULT 'pending',
          error text,
          indexed_at timestamptz
        )
        """
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS rag_chunks (
          id uuid PRIMARY KEY,
          note_id uuid NOT NULL REFERENCES note_notes(id) ON DELETE CASCADE,
          user_id uuid NOT NULL,
          chunk_index int NOT NULL,
          heading_path text,
          content text NOT NULL,
          content_hash char(64) NOT NULL,
          token_count int NOT NULL DEFAULT 0,
          meta jsonb NOT NULL DEFAULT '{}'::jsonb,
          embedding vector(768),
          tsv tsvector,
          created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute("CREATE INDEX IF NOT EXISTS idx_rag_chunks_note ON rag_chunks(note_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_rag_chunks_user ON rag_chunks(user_id)")
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_rag_chunks_hnsw "
        "ON rag_chunks USING hnsw (embedding vector_cosine_ops)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_rag_chunks_tsv "
        "ON rag_chunks USING gin (tsv)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS rag_index_jobs (
          id bigserial PRIMARY KEY,
          note_id uuid NOT NULL,
          user_id uuid NOT NULL,
          reason varchar(32) NOT NULL DEFAULT 'update',
          status varchar(16) NOT NULL DEFAULT 'pending',
          attempts int NOT NULL DEFAULT 0,
          scheduled_at timestamptz NOT NULL DEFAULT now(),
          error text
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_rag_jobs_pending "
        "ON rag_index_jobs(status, scheduled_at)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS rag_index_jobs")
    op.execute("DROP TABLE IF EXISTS rag_chunks")
    op.execute("DROP TABLE IF EXISTS rag_documents")
