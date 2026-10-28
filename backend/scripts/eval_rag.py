"""离线评测 RAG 检索质量（recall@5 / MRR），用于 P0 基线与 P1 分块后的对比。

用法（在 backend 目录下）::

    python -m scripts.eval_rag --email user@example.com \
        --dataset scripts/eval_dataset.sample.json

数据集格式::

    {
      "queries": [
        {
          "question": "报销流程有哪些审批节点？",
          "expected_note_titles": ["报销流程"]
        }
      ]
    }

说明：

- 评测口径是**笔记级**：前 5 篇里出现任一期望标题即算命中（P1 分块后可按块评测）。
- 检索路径与线上 `RagService` 一致：全文 + 语义混合、按分数取 Top-5。
- 嵌入服务不可用时只跑全文，并在报告里明确标注，避免把"语义没跑"误判为质量下降。
- 不写数据库、不调用 LLM，可安全地在 CI 之外的任意环境重复执行。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.user import User
from app.services.ai.embedding_service import EmbeddingService
from app.services.note.note_enhance_service import NoteSearchService


def _normalize(title: str) -> str:
    return " ".join((title or "").split()).lower()


async def _resolve_user_id(email: str):
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
        return user.id if user else None


async def evaluate(user_id, queries: list[dict], top_k: int) -> dict:
    hits = 0
    reciprocal_rank = 0.0
    rows: list[dict] = []
    semantic_available = True

    async with AsyncSessionLocal() as db:
        for query in queries:
            question = str(query.get("question") or "").strip()
            expected = [_normalize(t) for t in query.get("expected_note_titles") or []]
            if not question or not expected:
                continue

            fts_items, _ = await NoteSearchService.full_text_search(
                db, user_id=user_id, query=question, skip=0, limit=top_k * 4,
            )
            semantic_items = await EmbeddingService.semantic_search(
                db, user_id, question, limit=top_k * 4,
            )
            if not semantic_items:
                semantic_available = False

            merged: list[tuple[object, float]] = []
            seen: set[str] = set()
            for note in fts_items:
                seen.add(str(note.id))
                merged.append((note, 0.4))
            for note, similarity in semantic_items:
                if str(note.id) in seen:
                    continue
                seen.add(str(note.id))
                merged.append((note, 0.6 * similarity))
            merged.sort(key=lambda item: item[1], reverse=True)
            top = [note for note, _score in merged[:top_k]]

            top_titles = [_normalize(note.title) for note in top]
            rank = next(
                (index + 1 for index, title in enumerate(top_titles) if title in expected),
                0,
            )
            if rank:
                hits += 1
                reciprocal_rank += 1.0 / rank
            rows.append({
                "question": question,
                "expected": query.get("expected_note_titles") or [],
                "top": [note.title for note in top],
                "rank": rank,
            })

    total = len(rows) or 1
    return {
        "queries": len(rows),
        "recall_at_k": hits / total,
        "mrr": reciprocal_rank / total,
        "semantic_available": semantic_available,
        "rows": rows,
    }


async def main(args: argparse.Namespace) -> int:
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        print(f"[错误] 数据集不存在：{dataset_path}", file=sys.stderr)
        return 2
    payload = json.loads(dataset_path.read_text(encoding="utf-8"))
    queries = payload.get("queries") or []

    user_id = await _resolve_user_id(args.email)
    if user_id is None:
        print(f"[错误] 找不到用户：{args.email}", file=sys.stderr)
        return 2

    report = await evaluate(user_id, queries, args.top_k)
    print(f"用户: {args.email}")
    print(f"查询数: {report['queries']}")
    print(f"recall@{args.top_k}: {report['recall_at_k']:.2%}")
    print(f"MRR: {report['mrr']:.4f}")
    if not report["semantic_available"]:
        print("[提示] 嵌入服务不可用，本次只有全文检索结果")

    misses = [row for row in report["rows"] if not row["rank"]]
    if misses:
        print("\n未命中：")
        for row in misses:
            print(f"- {row['question']}")
            print(f"  期望: {', '.join(row['expected'])}")
            print(f"  实际: {', '.join(row['top']) or '（空）'}")

    if args.json:
        Path(args.json).write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\nJSON 报告已写入：{args.json}")

    # 低于阈值时以非零码退出，便于脚本/后续 CI 卡住检索质量回退
    return 0 if report["recall_at_k"] >= args.min_recall else 1


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="评测 RAG 检索质量（recall@k / MRR）")
    parser.add_argument("--email", required=True, help="用哪个用户的笔记做评测")
    parser.add_argument(
        "--dataset",
        default="scripts/eval_dataset.sample.json",
        help="评测集 JSON 路径",
    )
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--min-recall", type=float, default=0.0, help="低于该 recall 时返回非零码")
    parser.add_argument("--json", help="把完整报告写到指定 JSON 文件")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(_parse_args())))
