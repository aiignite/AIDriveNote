"""知识蒸馏质量评测：字段完整率、标题相似度、类型准确率。

用法：
    python -m scripts.eval_extract --dataset tests/data/knowledge_eval_sample.jsonl
    python -m scripts.eval_extract --mode llm --user-email you@example.com

默认只评测规则兜底（零成本）；``--mode llm`` 会真实调用用户可用的模型。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import uuid
from difflib import SequenceMatcher
from pathlib import Path
from types import SimpleNamespace

from app.services.knowledge.rule_extractor import build_rule_card

DEFAULT_DATASET = Path(__file__).resolve().parents[1] / "tests" / "data" / "knowledge_eval_sample.jsonl"


def _normalize(text: str) -> str:
    return re.sub(r"\s+", "", (text or "").lower())


def _evaluate_card(card, record: dict) -> dict:
    expected = record.get("expected") or {}
    checks: list[tuple[str, bool]] = []

    if expected.get("summary_contains"):
        terms = [str(term) for term in expected["summary_contains"]]
        checks.append(("summary", any(term in card.summary for term in terms)))
    if expected.get("key_points_min") is not None:
        checks.append(
            ("key_points", len(card.payload.get("key_points") or []) >= int(expected["key_points_min"]))
        )
    if expected.get("keywords_min") is not None:
        checks.append(
            ("keywords", len(card.payload.get("keywords") or []) >= int(expected["keywords_min"]))
        )
    if expected.get("knowledge_type"):
        checks.append(("knowledge_type", card.knowledge_type == expected["knowledge_type"]))

    completeness = sum(1 for _name, ok in checks if ok) / len(checks) if checks else 0.0
    title_similarity = SequenceMatcher(
        None, _normalize(expected.get("title") or record.get("title", "")), _normalize(card.title),
    ).ratio()
    return {
        "checks": {name: ok for name, ok in checks},
        "completeness": round(completeness, 4),
        "titleSimilarity": round(title_similarity, 4),
        "knowledgeType": card.knowledge_type,
        "extractor": card.extractor,
    }


def _rule_card(record: dict):
    doc = SimpleNamespace(
        title=record.get("title", ""),
        raw_text=record.get("text", ""),
        parse_meta={},
        source_type=record.get("source_type", "email"),
    )
    return build_rule_card(doc)


async def _llm_cards(records: list[dict], user_email: str) -> list:
    from sqlalchemy import select

    from app.database import AsyncSessionLocal
    from app.models.user import User
    from app.services.knowledge.knowledge_extract_service import extract_cards

    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == user_email))
        ).scalar_one_or_none()
        if user is None:
            raise SystemExit(f"用户不存在: {user_email}")
        results = []
        for record in records:
            doc = SimpleNamespace(
                id=uuid.uuid4(),
                user_id=user.id,
                title=record.get("title", ""),
                raw_text=record.get("text", ""),
                parse_meta={},
                source_type=record.get("source_type", "email"),
                occurred_at=None,
            )
            drafts = await extract_cards(db, doc, user.id)  # type: ignore[arg-type]
            results.append(drafts[0] if drafts else _rule_card(record))
        return results


def main() -> int:
    parser = argparse.ArgumentParser(description="知识蒸馏质量评测")
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET))
    parser.add_argument("--mode", choices=["rule", "llm"], default="rule")
    parser.add_argument("--user-email", default="")
    parser.add_argument("--min-completeness", type=float, default=0.5)
    parser.add_argument("--min-title-similarity", type=float, default=0.4)
    args = parser.parse_args()

    path = Path(args.dataset)
    if not path.exists():
        print(f"数据集不存在: {path}")
        return 2
    records = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    if not records:
        print("数据集为空")
        return 2

    if args.mode == "llm":
        if not args.user_email:
            print("--mode llm 需要同时提供 --user-email")
            return 2
        cards = asyncio.run(_llm_cards(records, args.user_email))
    else:
        cards = [_rule_card(record) for record in records]

    rows = [_evaluate_card(card, record) for card, record in zip(cards, records)]
    completeness = sum(row["completeness"] for row in rows) / len(rows)
    title_similarity = sum(row["titleSimilarity"] for row in rows) / len(rows)

    for record, row in zip(records, rows):
        failed = [name for name, ok in row["checks"].items() if not ok]
        print(
            f"- {record.get('title', '')[:36]:<36} "
            f"完整性={row['completeness']:.2f} 标题相似={row['titleSimilarity']:.2f} "
            f"类型={row['knowledgeType']} 失败={','.join(failed) or '无'}"
        )

    print(f"\n汇总：{len(rows)} 条  平均完整性={completeness:.3f}  平均标题相似={title_similarity:.3f}")
    passed = (
        completeness >= args.min_completeness
        and title_similarity >= args.min_title_similarity
    )
    print("PASS" if passed else "FAIL")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
