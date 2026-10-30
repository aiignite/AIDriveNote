"""RAG v2 检索：块级向量 + 全文 RRF 融合，输出结构化引用。"""
from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.services.ai.embedding_service import EmbeddingService
from app.services.ai.rag_v2_schema import rag_v2_available

logger = logging.getLogger(__name__)

RRF_K = 60


async def _resolve_scope_note_ids(
    db: AsyncSession,
    user_id: uuid.UUID,
    scope: dict[str, Any] | None,
) -> list[str] | None:
    """把 scope（note/folder/tag）解析成笔记 id 白名单；all/None 返回 None。"""
    if not scope:
        return None
    scope_type = str(scope.get("type") or "all")
    scope_id = scope.get("id")
    if scope_type == "all" or not scope_id:
        return None
    if scope_type == "note":
        return [str(scope_id)]
    if scope_type == "folder":
        result = await db.execute(
            text(
                """
                WITH RECURSIVE subtree AS (
                  SELECT id FROM note_folders WHERE id = :folder_id
                  UNION ALL
                  SELECT child.id FROM note_folders child
                  JOIN subtree parent ON child.parent_id = parent.id
                )
                SELECT n.id FROM note_notes n
                WHERE n.folder_id IN (SELECT id FROM subtree)
                  AND n.created_by = :user_id
                  AND n.is_deleted = false
                """
            ),
            {"folder_id": str(scope_id), "user_id": str(user_id)},
        )
        return [str(row[0]) for row in result.fetchall()]
    if scope_type == "tag":
        result = await db.execute(
            text(
                """
                SELECT n.id FROM note_notes n
                JOIN note_note_tags nt ON nt.note_id = n.id
                WHERE nt.tag_id = :tag_id
                  AND n.created_by = :user_id
                  AND n.is_deleted = false
                """
            ),
            {"tag_id": str(scope_id), "user_id": str(user_id)},
        )
        return [str(row[0]) for row in result.fetchall()]
    return None


def _filters(
    scope_ids: list[str] | None,
    note_type: str | None,
    date_from: str | None,
) -> tuple[str, dict[str, Any]]:
    clauses: list[str] = []
    params: dict[str, Any] = {}
    if scope_ids is not None:
        if not scope_ids:
            return " AND 1 = 0", {}
        placeholders = []
        for index, note_id in enumerate(scope_ids):
            key = f"scope_{index}"
            params[key] = note_id
            placeholders.append(f":{key}")
        clauses.append(f"n.id IN ({', '.join(placeholders)})")
    if note_type:
        clauses.append("n.note_type = :note_type")
        params["note_type"] = note_type
    if date_from:
        clauses.append("n.updated_at >= CAST(:date_from AS timestamptz)")
        params["date_from"] = date_from
    return (" AND " + " AND ".join(clauses)) if clauses else "", params


def _knowledge_filters(filters: dict[str, Any] | None) -> tuple[list[str], dict[str, Any]]:
    """来源类型 / 知识类型 / 起始时间过滤（走 rag_chunks.meta 索引）。"""
    if not filters:
        return [], {}
    clauses: list[str] = []
    params: dict[str, Any] = {}
    if filters.get("sourceType"):
        clauses.append("c.meta->>'source_type' = :k_source_type")
        params["k_source_type"] = str(filters["sourceType"])
    if filters.get("knowledgeType"):
        clauses.append("c.meta->>'knowledge_type' = :k_knowledge_type")
        params["k_knowledge_type"] = str(filters["knowledgeType"])
    if filters.get("occurredFrom"):
        clauses.append("(c.meta->>'occurred_at') >= :k_occurred_from")
        params["k_occurred_from"] = str(filters["occurredFrom"])
    return clauses, params


async def search_chunks(
    db: AsyncSession,
    user_id: uuid.UUID,
    query: str,
    *,
    top_k: int = 8,
    scope: dict[str, Any] | None = None,
    knowledge_filters: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """返回按 RRF 融合排序的块；RAG v2 不可用时返回 None。"""
    if not await rag_v2_available(db):
        return None
    settings = get_settings()
    candidates = settings.RAG_V2_CANDIDATES
    # 启用重排时多取一些候选，重排后再截断
    fetch_k = max(top_k, settings.RERANK_CANDIDATES) if settings.RERANK_ENABLED else top_k
    scope_ids = await _resolve_scope_note_ids(db, user_id, scope)
    filter_sql, filter_params = _filters(
        scope_ids,
        (scope or {}).get("noteType") if scope else None,
        (scope or {}).get("dateFrom") if scope else None,
    )
    extra_clauses, extra_params = _knowledge_filters(knowledge_filters)
    if extra_clauses:
        filter_sql += " AND " + " AND ".join(extra_clauses)
        filter_params.update(extra_params)

    query_embedding = await EmbeddingService.embed_query(query)
    base_params: dict[str, Any] = {
        "user_id": str(user_id),
        "query": query,
        "like": f"%{query.strip()}%",
        # 长问句整句 ILIKE 往往失配，短前缀用于兜底召回
        "like_short": f"%{query.strip()[:8]}%",
        "candidates": candidates,
        "top_k": fetch_k,
        "summary_boost": settings.KNOWLEDGE_SUMMARY_CHUNK_BOOST,
        **filter_params,
    }

    if query_embedding:
        sql = f"""
            WITH vector_hits AS (
              SELECT c.id,
                     row_number() OVER (ORDER BY c.embedding <=> CAST(:vec AS vector)) AS rank
              FROM rag_chunks c
              JOIN note_notes n ON n.id = c.note_id
              WHERE (c.user_id = :user_id OR EXISTS (
                       SELECT 1 FROM note_shares s
                       WHERE s.note_id = n.id AND s.shared_with_user_id = :user_id
                     ))
                AND c.embedding IS NOT NULL
                AND n.is_deleted = false
                AND n.is_encrypted = false
                {filter_sql}
              ORDER BY c.embedding <=> CAST(:vec AS vector)
              LIMIT :candidates
            ), fts_hits AS (
              SELECT c.id,
                     row_number() OVER (
                       ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', :query)) DESC,
                                c.chunk_index ASC
                     ) AS rank
              FROM rag_chunks c
              JOIN note_notes n ON n.id = c.note_id
              WHERE (c.user_id = :user_id OR EXISTS (
                       SELECT 1 FROM note_shares s
                       WHERE s.note_id = n.id AND s.shared_with_user_id = :user_id
                     ))
                AND n.is_deleted = false
                AND n.is_encrypted = false
                AND (c.tsv @@ plainto_tsquery('simple', :query) OR c.content ILIKE :like
                     OR c.content ILIKE :like_short)
                {filter_sql}
              LIMIT :candidates
            ), merged AS (
              SELECT COALESCE(v.id, f.id) AS id,
                     COALESCE(1.0 / ({RRF_K} + v.rank), 0)
                     + COALESCE(1.0 / ({RRF_K} + f.rank), 0) AS score
              FROM vector_hits v
              FULL OUTER JOIN fts_hits f ON v.id = f.id
            )
            SELECT c.id, c.note_id, c.chunk_index, c.heading_path, c.content, c.meta,
                   (m.score + CASE WHEN c.meta->>'is_summary' = 'true'
                                   THEN :summary_boost ELSE 0 END) AS score,
                   n.title, n.note_no, n.note_type
            FROM merged m
            JOIN rag_chunks c ON c.id = m.id
            JOIN note_notes n ON n.id = c.note_id
            ORDER BY (m.score + CASE WHEN c.meta->>'is_summary' = 'true'
                                     THEN :summary_boost ELSE 0 END) DESC
            LIMIT :top_k
        """
        base_params["vec"] = "[" + ",".join(str(float(x)) for x in query_embedding) + "]"
    else:
        # 嵌入服务不可用：只走全文/模糊，保持检索可用但显式降级
        sql = f"""
            WITH fts_hits AS (
              SELECT c.id,
                     row_number() OVER (
                       ORDER BY ts_rank(c.tsv, plainto_tsquery('simple', :query)) DESC,
                                c.chunk_index ASC
                     ) AS rank
              FROM rag_chunks c
              JOIN note_notes n ON n.id = c.note_id
              WHERE (c.user_id = :user_id OR EXISTS (
                       SELECT 1 FROM note_shares s
                       WHERE s.note_id = n.id AND s.shared_with_user_id = :user_id
                     ))
                AND n.is_deleted = false
                AND n.is_encrypted = false
                AND (c.tsv @@ plainto_tsquery('simple', :query) OR c.content ILIKE :like
                     OR c.content ILIKE :like_short)
                {filter_sql}
              LIMIT :candidates
            )
            SELECT c.id, c.note_id, c.chunk_index, c.heading_path, c.content, c.meta,
                   ((1.0 / ({RRF_K} + f.rank))
                    + CASE WHEN c.meta->>'is_summary' = 'true' THEN :summary_boost ELSE 0 END) AS score,
                   n.title, n.note_no, n.note_type
            FROM fts_hits f
            JOIN rag_chunks c ON c.id = f.id
            JOIN note_notes n ON n.id = c.note_id
            ORDER BY ((1.0 / ({RRF_K} + f.rank))
                      + CASE WHEN c.meta->>'is_summary' = 'true' THEN :summary_boost ELSE 0 END) DESC
            LIMIT :top_k
        """

    try:
        result = await db.execute(text(sql), base_params)
        rows = [dict(row._mapping) for row in result.fetchall()]
    except Exception:  # noqa: BLE001 — SQL 失败时回退 v1，避免聊天整体失败
        logger.warning("RAG v2 检索失败，回退 v1", exc_info=True)
        return None

    if settings.RERANK_ENABLED and len(rows) > 1:
        from app.services.ai.rerank_service import rerank

        order = await rerank(query, [str(row.get("content") or "") for row in rows])
        if order:
            rows = [rows[index] for index in order if 0 <= index < len(rows)]
    return rows


async def build_context(
    db: AsyncSession,
    user_id: uuid.UUID,
    query: str,
    *,
    top_k: int = 5,
    page_context: dict[str, Any] | None = None,
    knowledge_filters: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, Any]]] | None:
    """返回 (上下文文本, 结构化引用)；v2 不可用或无命中时返回 None。"""
    scope = (page_context or {}).get("ragScope")
    rows = await search_chunks(
        db, user_id, query, top_k=top_k, scope=scope, knowledge_filters=knowledge_filters,
    )
    if rows is None:
        return None
    # 同一笔记多个块命中时只保留最高分块，避免上下文被单篇笔记刷屏
    deduped: list[dict[str, Any]] = []
    seen_notes: set[str] = set()
    for row in rows:
        note_id = str(row["note_id"])
        if note_id in seen_notes:
            continue
        seen_notes.add(note_id)
        deduped.append(row)
        if len(deduped) >= top_k:
            break
    if not deduped:
        return None

    lines: list[str] = []
    citations: list[dict[str, Any]] = []
    for row in deduped:
        heading = row.get("heading_path") or ""
        label = row["title"] + (f" > {heading}" if heading else "")
        content = (row.get("content") or "").strip()
        meta = row.get("meta") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except json.JSONDecodeError:
                meta = {}
        summary = str(meta.get("summary") or "").strip()
        prefix = f"[摘要：{summary[:200]}] " if summary else ""
        lines.append(
            f"- [{label}](note_id={row['note_id']}): {prefix}{content[:600]}"
        )
        citations.append({
            "noteId": str(row["note_id"]),
            "noteNo": row.get("note_no"),
            "title": row["title"],
            "quote": content[:300],
            "chunkId": str(row["id"]),
            "headingPath": heading or None,
            "source": "retrieval",
            "summary": summary or None,
            "knowledgeType": meta.get("knowledge_type"),
            "sourceType": meta.get("source_type"),
            "sourceUrl": meta.get("source_url"),
        })

    context = (
        "## 相关笔记片段（引用格式 [标题](note_id=...)）\n"
        "请优先依据以下片段回答，并在回答中引用 note_id；片段不足以回答时明确说明。\n"
        + "\n".join(lines)
    )
    return context, citations


class RagV2Service:
    """类封装，保持与 RagService 一致的调用风格。"""

    search_chunks = staticmethod(search_chunks)
    build_context = staticmethod(build_context)

    @staticmethod
    async def get_chunk(
        db: AsyncSession,
        user_id: uuid.UUID,
        note_id: uuid.UUID,
        chunk_id: uuid.UUID,
    ) -> dict[str, Any] | None:
        """按 chunk id 取回引用原文；共享笔记同样可读。"""
        if not await rag_v2_available(db):
            return None
        result = await db.execute(
            text(
                """
                SELECT c.id, c.note_id, c.heading_path, c.content, n.title
                FROM rag_chunks c
                JOIN note_notes n ON n.id = c.note_id
                WHERE c.id = :chunk_id
                  AND c.note_id = :note_id
                  AND n.is_deleted = false
                  AND n.is_encrypted = false
                  AND (
                    c.user_id = :user_id
                    OR EXISTS (
                      SELECT 1 FROM note_shares s
                      WHERE s.note_id = n.id AND s.shared_with_user_id = :user_id
                    )
                  )
                """
            ),
            {
                "chunk_id": str(chunk_id),
                "note_id": str(note_id),
                "user_id": str(user_id),
            },
        )
        row = result.first()
        if row is None:
            return None
        return {
            "chunkId": str(row[0]),
            "noteId": str(row[1]),
            "headingPath": row[2],
            "content": row[3],
            "title": row[4],
        }
