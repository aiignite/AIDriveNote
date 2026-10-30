"""RAG v2 的 PostgreSQL / pgvector schema。

刻意不用 ORM 声明这些表：测试使用 SQLite 内存库，vector 类型与 HNSW 索引在
SQLite 下不可用，放进 Base.metadata 会让全量 create_all 失败。这里用幂等 DDL
建表，服务层用原生 SQL 访问；非 PostgreSQL 部署会整体降级回 RAG v1。
"""
from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings

logger = logging.getLogger(__name__)

# pgvector 的 HNSW 索引上限是 2000 维；超过时不建索引，退回精确扫描
HNSW_MAX_DIM = 2000


def _embedding_dim() -> int:
    try:
        return max(1, int(get_settings().EMBEDDING_DIM or 768))
    except (TypeError, ValueError):
        return 768


def _ddl_statements(dim: int) -> tuple[str, ...]:
    statements: list[str] = [
        "CREATE EXTENSION IF NOT EXISTS vector",
        """
        CREATE TABLE IF NOT EXISTS rag_documents (
          note_id uuid PRIMARY KEY REFERENCES note_notes(id) ON DELETE CASCADE,
          user_id uuid NOT NULL,
          content_hash char(64) NOT NULL,
          chunk_count int NOT NULL DEFAULT 0,
          status varchar(20) NOT NULL DEFAULT 'pending',
          error text,
          indexed_at timestamptz,
          embedding_model varchar(120)
        )
        """,
        "ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_model varchar(120)",
        f"""
        CREATE TABLE IF NOT EXISTS rag_chunks (
          id uuid PRIMARY KEY,
          note_id uuid NOT NULL REFERENCES note_notes(id) ON DELETE CASCADE,
          user_id uuid NOT NULL,
          chunk_index int NOT NULL,
          heading_path text,
          content text NOT NULL,
          content_hash char(64) NOT NULL,
          token_count int NOT NULL DEFAULT 0,
          meta jsonb NOT NULL DEFAULT '{{}}'::jsonb,
          embedding vector({dim}),
          tsv tsvector,
          created_at timestamptz NOT NULL DEFAULT now()
        )
        """,
        "CREATE INDEX IF NOT EXISTS idx_rag_chunks_note ON rag_chunks(note_id)",
        "CREATE INDEX IF NOT EXISTS idx_rag_chunks_user ON rag_chunks(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_rag_chunks_tsv ON rag_chunks USING gin (tsv)",
        "CREATE INDEX IF NOT EXISTS ix_rag_chunks_meta ON rag_chunks USING gin (meta jsonb_path_ops)",
        "CREATE INDEX IF NOT EXISTS ix_rag_chunks_source ON rag_chunks ((meta->>'source_type'))",
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
        """,
        "CREATE INDEX IF NOT EXISTS idx_rag_jobs_pending ON rag_index_jobs(status, scheduled_at)",
    ]
    if dim <= HNSW_MAX_DIM:
        statements.append(
            "CREATE INDEX IF NOT EXISTS idx_rag_chunks_hnsw "
            "ON rag_chunks USING hnsw (embedding vector_cosine_ops)"
        )
    else:
        logger.info("向量维度 %s 超过 HNSW 上限 %s，改用精确扫描", dim, HNSW_MAX_DIM)
    return tuple(statements)


def _is_postgres(db: AsyncSession) -> bool:
    try:
        return db.get_bind().dialect.name == "postgresql"
    except Exception:  # noqa: BLE001
        return False


async def ensure_rag_schema(db: AsyncSession) -> bool:
    """幂等建表；非 PostgreSQL / 未安装 pgvector 时返回 False（不抛错）。"""
    if not _is_postgres(db):
        return False
    try:
        available = await db.execute(
            text("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"),
        )
        if available.first() is None:
            logger.info("当前 PostgreSQL 未提供 pgvector 扩展，RAG v2 停用（自动回退 v1）")
            return False
        for statement in _ddl_statements(_embedding_dim()):
            await db.execute(text(statement))
        await db.commit()
        return True
    except Exception:  # noqa: BLE001 — 缺扩展/权限时降级，不阻断启动
        await db.rollback()
        logger.warning("RAG v2 schema 初始化失败，语义检索将回退 v1", exc_info=True)
        return False


async def rag_v2_available(db: AsyncSession) -> bool:
    """检查扩展与表是否就绪（每次调用很轻，避免缓存跨连接失效）。"""
    if not _is_postgres(db):
        return False
    try:
        extension = await db.execute(
            text("SELECT 1 FROM pg_extension WHERE extname = 'vector'"),
        )
        if extension.first() is None:
            return False
        table = await db.execute(text("SELECT to_regclass('public.rag_chunks')"))
        return table.scalar() is not None
    except Exception:  # noqa: BLE001
        return False
