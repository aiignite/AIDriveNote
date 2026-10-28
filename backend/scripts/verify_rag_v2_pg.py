"""真实 PostgreSQL + pgvector 冒烟验证（不依赖 Ollama）。

用法：先把 DATABASE_URL / DATABASE_URL_SYNC 指向一个一次性测试库，
再执行 ``python -m scripts.verify_rag_v2_pg``。验证内容：

1. ``ensure_rag_schema`` 能建出扩展、表与 HNSW/GIN 索引；
2. 向量检索能按余弦距离命中目标块（RRF 融合）；
3. ``build_context`` 返回块级引用（chunkId/headingPath）。
"""
from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import text

from app.database import AsyncSessionLocal
from app.models.note.note import Note, NoteShare
from app.models.user import User
from app.services.ai.embedding_service import EmbeddingService
from app.services.ai.rag_v2_schema import ensure_rag_schema, rag_v2_available
from app.services.ai.rag_v2_service import RagV2Service

DIM = 768


def _unit_vec(index: int) -> list[float]:
    vector = [0.0] * DIM
    vector[index] = 1.0
    return vector


async def main() -> int:
    async with AsyncSessionLocal() as db:
        assert await ensure_rag_schema(db), "RAG v2 schema 初始化失败"
        assert await rag_v2_available(db), "pgvector / rag_chunks 不可用"

        index_name = (
            await db.execute(
                text(
                    "SELECT indexname FROM pg_indexes "
                    "WHERE tablename = 'rag_chunks' AND indexname = 'idx_rag_chunks_hnsw'"
                )
            )
        ).scalar()
        assert index_name, "HNSW 索引未创建"

        user = User(
            email=f"ragtest-{uuid.uuid4().hex[:8]}@local",
            password_hash="x",
            name="RAG Test",
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        note = Note(
            note_no=f"T{uuid.uuid4().hex[:10]}",
            title="向量检索验证",
            note_type="markdown",
            content={"text": "部署回滚预案"},
            is_encrypted=False,
            created_by=user.id,
            updated_by=user.id,
        )
        db.add(note)
        await db.commit()
        await db.refresh(note)

        # 共享笔记验证：笔记属于 owner，viewer 只是被分享者，检索应能命中
        viewer = User(
            email=f"ragviewer-{uuid.uuid4().hex[:8]}@local",
            password_hash="x",
            name="RAG Viewer",
        )
        db.add(viewer)
        await db.commit()
        await db.refresh(viewer)
        db.add(NoteShare(
            note_id=note.id,
            shared_with_user_id=viewer.id,
            permission="view",
            created_by=user.id,
        ))
        await db.commit()

        query_vector = _unit_vec(0)
        chunks = [
            (query_vector, "命中块：部署回滚预案与演练步骤"),
            (_unit_vec(1), "无关块：午餐菜单与订餐"),
        ]
        for index, (embedding, content) in enumerate(chunks):
            await db.execute(
                text(
                    """
                    INSERT INTO rag_chunks
                      (id, note_id, user_id, chunk_index, heading_path, content,
                       content_hash, token_count, meta, embedding, tsv)
                    VALUES
                      (:id, :note_id, :user_id, :chunk_index, :heading_path, :content,
                       :content_hash, :token_count, CAST(:meta AS jsonb),
                       CAST(:embedding AS vector), to_tsvector('simple', :content))
                    """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "note_id": str(note.id),
                    "user_id": str(user.id),
                    "chunk_index": index,
                    "heading_path": "部署 > 回滚",
                    "content": content,
                    "content_hash": uuid.uuid4().hex,
                    "token_count": 20,
                    "meta": "{}",
                    "embedding": "[" + ",".join(str(x) for x in embedding) + "]",
                },
            )
        await db.commit()

        async def fake_embed(_text: str) -> list[float]:
            return query_vector

        EmbeddingService.embed_text = staticmethod(fake_embed)  # type: ignore[method-assign]

        rows = await RagV2Service.search_chunks(db, viewer.id, "部署回滚", top_k=3)
        assert rows, "向量检索没有返回结果"
        assert rows[0]["content"].startswith("命中块"), f"排序错误: {rows[0]['content']}"

        context, citations = await RagV2Service.build_context(
            db, viewer.id, "部署回滚", top_k=3,
        )
        assert context and "相关笔记片段" in context
        assert citations and citations[0]["chunkId"] and citations[0]["headingPath"]
        assert citations[0]["noteId"] == str(note.id), "共享笔记未被引用"

        chunk = await RagV2Service.get_chunk(
            db, viewer.id, note.id, uuid.UUID(citations[0]["chunkId"]),
        )
        assert chunk and chunk["content"].startswith("命中块"), "块级引用无法取回原文"

        # 清理验证数据（测试库随后由外部脚本整体删除）
        await db.execute(text("DELETE FROM note_shares WHERE note_id = :id"), {"id": str(note.id)})
        await db.execute(text("DELETE FROM rag_chunks WHERE note_id = :id"), {"id": str(note.id)})
        await db.execute(text("DELETE FROM rag_documents WHERE note_id = :id"), {"id": str(note.id)})
        await db.execute(text("DELETE FROM note_notes WHERE id = :id"), {"id": str(note.id)})
        await db.execute(
            text("DELETE FROM users WHERE email LIKE 'ragtest-%' OR email LIKE 'ragviewer-%'"),
        )
        await db.commit()

        print("PASS: pgvector schema / HNSW / RRF 检索 / 块级引用 / 共享笔记 均正常")
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
