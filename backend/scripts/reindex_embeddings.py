"""回填 / 重建笔记语义索引与检索字段。

用法（在 backend 目录下）::

    python -m scripts.reindex_embeddings --all
    python -m scripts.reindex_embeddings --email user@example.com
    python -m scripts.reindex_embeddings --all --limit 100 --batch 20

设计要点：

- 幂等：按当前正文重新计算，可重复执行。
- 跳过加密笔记（避免把明文写进向量/检索字段）。
- ``--skip-search-fields`` 只重建向量；默认连 ``search_text`` / ``search_vector``
  一起重建，用于修复历史数据里流程图/正文缺失的检索文本。
- 嵌入服务不可用时（Ollama 未启动）会报告失败条数并以非零码退出，便于脚本
  和 CI 发现"索引没建成"。
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.note.note import Note
from app.models.user import User
from app.services.ai.embedding_service import EmbeddingService
from app.services.ai.rag_index_service import index_note
from app.services.ai.rag_v2_schema import rag_v2_available
from app.services.note.note_enhance_service import NoteSearchService


async def _resolve_user_id(email: str) -> object | None:
    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == email))
        ).scalar_one_or_none()
        return user.id if user else None


async def main(args: argparse.Namespace) -> int:
    user_id = None
    if args.email:
        user_id = await _resolve_user_id(args.email)
        if user_id is None:
            print(f"[错误] 找不到用户：{args.email}", file=sys.stderr)
            return 2

    async with AsyncSessionLocal() as db:
        stmt = select(Note.id).where(
            Note.is_deleted == False,  # noqa: E712
            Note.is_encrypted == False,  # noqa: E712
        )
        if user_id:
            stmt = stmt.where(Note.created_by == user_id)
        stmt = stmt.order_by(Note.updated_at.asc())
        if args.limit:
            stmt = stmt.limit(args.limit)
        note_ids = list((await db.execute(stmt)).scalars().all())

    total = len(note_ids)
    print(f"待重建 {total} 篇笔记")
    ok = failed = 0

    async with AsyncSessionLocal() as db:
        use_v2 = await rag_v2_available(db)
        print("索引模式：", "RAG v2（分块 + pgvector）" if use_v2 else "RAG v1（整篇向量）")
        for index, note_id in enumerate(note_ids, 1):
            note = await db.get(Note, note_id)
            if note is None or note.is_deleted or note.is_encrypted:
                continue
            if not args.skip_search_fields:
                await NoteSearchService.update_search_fields(db, note)
            succeeded = await EmbeddingService.update_note_embedding(db, note)
            if use_v2:
                # v2 块索引失败不应掩盖 v1 结果：两者都有才算完全成功
                try:
                    await index_note(db, note)
                except Exception as exc:  # noqa: BLE001
                    print(f"  [警告] v2 分块索引失败 note={note_id}: {exc}")
                    succeeded = False
            ok += 1 if succeeded else 0
            failed += 0 if succeeded else 1
            if index % max(1, args.batch) == 0:
                await db.commit()
                print(f"  {index}/{total} 完成（成功 {ok} / 失败 {failed}）")
        await db.commit()

    print(f"完成：成功 {ok}，失败 {failed}，共 {total}")
    return 0 if failed == 0 else 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="重建 AIDriveNote 笔记语义索引")
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--all", action="store_true", help="重建全部未删除笔记")
    scope.add_argument("--email", help="只重建指定用户的笔记")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少篇（0 = 不限）")
    parser.add_argument("--batch", type=int, default=50, help="每多少篇提交一次")
    parser.add_argument(
        "--skip-search-fields",
        action="store_true",
        help="只重建向量，不重建 search_text / search_vector",
    )
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(_parse_args())))
