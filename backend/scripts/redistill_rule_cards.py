"""把已经批准、但由规则兜底的蒸馏卡用大模型重做，并原地更新对应笔记。

用法（在 backend 目录下）::

    python -m scripts.redistill_rule_cards                  # 预演，只报告
    python -m scripts.redistill_rule_cards --apply          # 实际重做
    python -m scripts.redistill_rule_cards --apply --limit 4

只处理「蒸馏产出」目录下、状态为 approved、extractor=rule 的卡片。重做成功后原地更新
卡片字段与笔记正文（保留笔记 ID、标题、目录与已有标签），失败或模型仍不可用时保持原样。
每次重做都会触发笔记修订记录，旧正文可从版本历史恢复。
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime, timezone

from sqlalchemy import select  # noqa: E402
from sqlalchemy.orm import aliased  # noqa: E402

from app.database import AsyncSessionLocal  # noqa: E402
from app.models.knowledge import IngestDocument, KnowledgeCard  # noqa: E402
from app.models.note.note import Note, NoteFolder  # noqa: E402
from app.services.knowledge.knowledge_compile_service import (  # noqa: E402
    DISTILL_ROOT_NAME,
    _description,
    render_card_markdown,
)
from app.services.knowledge.knowledge_extract_service import extract_cards  # noqa: E402
from app.services.note.note_enhance_service import NoteTagService  # noqa: E402
from app.services.note.note_service import NoteService  # noqa: E402

CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1}


def _pick_draft(drafts, card: KnowledgeCard):
    """优先同知识类型的模型草稿，其次置信度最高的模型草稿。"""
    llm_drafts = [draft for draft in drafts if draft.extractor == "llm"]
    if not llm_drafts:
        return None
    same_type = [draft for draft in llm_drafts if draft.knowledge_type == card.knowledge_type]
    pool = same_type or llm_drafts
    return max(pool, key=lambda draft: CONFIDENCE_RANK.get(draft.confidence, 0))


async def _sync_topic_tags(db, card: KnowledgeCard, note_id) -> None:
    """对齐派生标签：清掉不再匹配的 topic: 标签，补上新主题与 payload 标签。"""
    payload = card.payload or {}
    topic_tag = f"topic:{payload['topic']}"[:50] if payload.get("topic") else None
    desired = [topic_tag] if topic_tag else []
    desired.extend(str(tag).strip()[:40] for tag in payload.get("tags") or [] if str(tag).strip())
    desired = list(dict.fromkeys(name for name in desired if name))

    existing = await NoteTagService.get_note_tags(db, note_id)
    for tag in existing:
        if tag.name.startswith("topic:") and tag.name not in desired:
            await NoteTagService.remove_tag_from_note(db, note_id, tag.id)

    known = {tag.name.lower(): tag for tag in await NoteTagService.list_tags(db, card.user_id)}
    for name in desired[:10]:
        key = name.lower()
        tag = known.get(key)
        if tag is None:
            tag = await NoteTagService.create_tag(db, card.user_id, name)
            known[key] = tag
        await NoteTagService.add_tag_to_note(db, note_id, tag.id, card.user_id)


async def _apply_draft(db, card: KnowledgeCard, doc: IngestDocument, draft) -> None:
    card.summary = draft.summary
    card.payload = draft.payload
    card.confidence = draft.confidence
    card.extractor = draft.extractor
    card.model = draft.model
    card.prompt_version = draft.prompt_version
    card.input_tokens = draft.input_tokens
    card.output_tokens = draft.output_tokens

    kb_target = dict(card.kb_target or {})
    frontmatter = dict(kb_target.get("frontmatter") or {})
    frontmatter["tags"] = [str(tag).strip() for tag in draft.payload.get("tags") or [] if str(tag).strip()]
    frontmatter["topic"] = draft.payload.get("topic") or ""
    frontmatter["confidence"] = draft.confidence
    frontmatter["updated"] = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    kb_target["frontmatter"] = frontmatter

    content = render_card_markdown(card, doc)
    kb_target["wikiBody"] = content
    card.kb_target = kb_target

    note = await NoteService.get_note(db, card.note_id)
    if note is None:
        raise RuntimeError("对应笔记不存在")
    await NoteService.update_note(
        db,
        note.id,
        {
            "content": {"text": content},
            "description": _description(card, kb_target),
            "updated_by": card.user_id,
        },
        change_summary="规则兜底卡改用大模型重做",
    )
    await _sync_topic_tags(db, card, note.id)


async def main(apply: bool, limit: int | None) -> int:
    async with AsyncSessionLocal() as db:
        parent = aliased(NoteFolder)
        rows = (
            await db.execute(
                select(
                    KnowledgeCard.id,
                    KnowledgeCard.document_id,
                    KnowledgeCard.user_id,
                    KnowledgeCard.title,
                    KnowledgeCard.knowledge_type,
                )
                .join(Note, Note.id == KnowledgeCard.note_id)
                .join(NoteFolder, NoteFolder.id == Note.folder_id)
                .join(parent, parent.id == NoteFolder.parent_id)
                .where(
                    KnowledgeCard.extractor == "rule",
                    KnowledgeCard.status == "approved",
                    Note.is_deleted == False,  # noqa: E712
                    parent.name == DISTILL_ROOT_NAME,
                )
                .order_by(KnowledgeCard.created_at)
            )
        ).all()
        if limit is not None:
            rows = rows[:limit]

        if not rows:
            print("没有需要重做的规则兜底卡。")
            return 0

        updated = skipped = 0
        for card_id, document_id, user_id, title, knowledge_type in rows:
            if not apply:
                # 预演不调用模型，避免白耗额度
                print(f"[待重做] 《{title}》（{knowledge_type}，规则兜底）")
                continue
            card = await db.get(KnowledgeCard, card_id)
            doc = await db.get(IngestDocument, document_id)
            if card is None or doc is None:
                skipped += 1
                print(f"[跳过] 《{title}》 卡片或源文档已不存在")
                continue
            try:
                drafts = await extract_cards(db, doc, user_id)
                draft = _pick_draft(drafts, card)
                if draft is None:
                    skipped += 1
                    print(f"[跳过] 《{title}》 模型仍不可用（限额/调用失败），保持规则卡")
                    continue
                await _apply_draft(db, card, doc, draft)
            except Exception as exc:  # noqa: BLE001 — 单篇失败不阻断其余
                await db.rollback()
                skipped += 1
                print(f"[失败] 《{title}》 {exc}")
                continue
            updated += 1
            print(
                f"[已重做] 《{title}》 {draft.confidence}"
                f"（{draft.model or 'LLM'}，{draft.input_tokens or 0}/{draft.output_tokens or 0} tokens）"
            )

        if not apply:
            print(f"共 {len(rows)} 篇；加 --apply 执行（会调用模型）。")
        else:
            print(f"完成：重做 {updated} 篇，跳过 {skipped} 篇。")
        return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="用大模型重做规则兜底的蒸馏卡")
    parser.add_argument("--apply", action="store_true", help="实际写入（默认只预演）")
    parser.add_argument("--limit", type=int, default=None, help="最多处理 N 篇")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.apply, args.limit)))
