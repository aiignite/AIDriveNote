"""知识编译：把批准的知识卡落成 Note，并生成知识库写回目标。"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.knowledge import IngestDocument, KnowledgeCard, NoteSource
from app.models.note.note import Note, NoteFolder
from app.services.note.note_enhance_service import NoteTagService
from app.services.note.note_service import NoteService

KB_DIRS = {
    "concept": ("concepts", "concept"),
    "entity": ("entities", "entity"),
    "topic": ("topics", "topic"),
    "decision": ("decisions", "decision"),
    "note": ("topics", "topic"),
}

_ILLEGAL_FILENAME_RE = re.compile(r'[\s\\/:*?"<>|]+')


def _slug(value: str, fallback: str = "知识") -> str:
    cleaned = _ILLEGAL_FILENAME_RE.sub("-", (value or "").strip()).strip("-")
    cleaned = re.sub(r"-{2,}", "-", cleaned)
    return (cleaned or fallback)[:80]


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _source_label(doc: IngestDocument) -> str:
    labels = {
        "email": "邮件",
        "upload": "上传文档",
        "clip": "网页剪藏",
        "web_clip": "网页分享",
        "mcp": "Agent 推送",
        "note": "自写笔记",
        "kb": "知识库文件",
    }
    return labels.get(doc.source_type, doc.source_type)


def _raw_path(card: KnowledgeCard, doc: IngestDocument) -> str:
    """raw 快照路径：网页类进 raw/web，其余统一进 raw/notes。

    后端不保存上传原件，因此 raw 层写入的是「抽取后的文本快照」，
    sources 指向这个快照文件，保证引用路径真实可打开。
    """
    if doc.source_type in {"clip", "web_clip"}:
        return f"raw/web/{_today()}-{_slug(_source_label(doc))}-{_slug(card.title)}.md"
    return f"raw/notes/{_today()}-{_slug(card.title)}.md"


def render_card_markdown(
    card: KnowledgeCard,
    doc: IngestDocument,
    *,
    related_titles: list[str] | None = None,
) -> str:
    payload = card.payload or {}
    key_points = [str(item).strip() for item in payload.get("key_points") or [] if str(item).strip()]
    keywords = [str(item).strip() for item in payload.get("keywords") or [] if str(item).strip()]
    entities = payload.get("entities") or []
    claims = payload.get("claims") or []

    parts = [f"> 摘要：{card.summary.strip()}", ""]
    if key_points:
        parts.append("## 要点")
        parts.extend(f"- {point}" for point in key_points)
        parts.append("")
    if keywords or entities:
        parts.append("## 关键概念")
        if keywords:
            parts.append(f"- **关键词**：{'、'.join(keywords[:8])}")
        if entities:
            rendered = "、".join(
                f"{entity.get('name')}（{entity.get('type') or '概念'}）"
                for entity in entities[:8]
                if isinstance(entity, dict) and entity.get("name")
            )
            if rendered:
                parts.append(f"- **实体**：{rendered}")
        parts.append("")
    if claims:
        parts.append("## 依据")
        for claim in claims[:6]:
            if not isinstance(claim, dict) or not claim.get("text"):
                continue
            excerpt = str(claim.get("source_excerpt") or "").strip()
            suffix = f"（原文：{excerpt[:160]}）" if excerpt else ""
            parts.append(f"- {claim.get('text')}{suffix}")
        parts.append("")

    source_line = f"- {_source_label(doc)}《{doc.title or card.title}》{_today()}"
    if doc.url:
        source_line += f" · {doc.url}"
    parts.extend(["## 来源", source_line, ""])

    if related_titles:
        parts.append("## 相关")
        parts.extend(f"- [[{title}]]" for title in related_titles[:8])
        parts.append("")

    return "\n".join(parts).strip() + "\n"


def _kb_type(card: KnowledgeCard) -> tuple[str, str]:
    return KB_DIRS.get(card.knowledge_type, KB_DIRS["note"])


def build_kb_target(
    card: KnowledgeCard,
    doc: IngestDocument,
    *,
    related_titles: list[str] | None = None,
) -> dict:
    directory, kb_type = _kb_type(card)
    raw_path = _raw_path(card, doc)
    wiki_path = f"wiki/{directory}/{_slug(card.title)}.md"
    payload = card.payload or {}
    tags = [str(tag).strip() for tag in payload.get("tags") or [] if str(tag).strip()]
    frontmatter = {
        "title": card.title,
        "type": kb_type,
        "tags": tags,
        "topic": payload.get("topic") or "",
        "sources": [raw_path],
        "related": [f"wiki/entities/{_slug(title)}.md" for title in (related_titles or [])][:8],
        "created": _today(),
        "updated": _today(),
        "confidence": card.confidence,
    }
    return {
        "rawPath": raw_path,
        "wikiPath": wiki_path,
        "frontmatter": frontmatter,
        "indexLine": f"- [{card.title}]({wiki_path}) — {card.summary[:80]}",
        "logLine": f"- {_today()} ingest {doc.source_type} → {wiki_path}",
    }


def _description(card: KnowledgeCard, kb_target: dict | None) -> str:
    description = card.summary.strip()[:500]
    if not kb_target:
        return description
    related = (kb_target.get("frontmatter") or {}).get("related") or []
    parts = [
        f"confidence: {card.confidence}",
        f"sources: [{kb_target['rawPath']}]",
    ]
    if related:
        parts.append(f"related: [{', '.join(str(item) for item in related)}]")
    meta = "[kb] " + " | ".join(parts)
    return f"{description}\n{meta}"[:1000]


async def _add_tags(
    db: AsyncSession,
    user_id: uuid.UUID,
    note_id: uuid.UUID,
    card: KnowledgeCard,
) -> None:
    payload = card.payload or {}
    names = [f"kb:{card.knowledge_type}"]
    if payload.get("topic"):
        names.append(f"topic:{payload['topic']}"[:50])
    names.extend(str(tag) for tag in payload.get("tags") or [] if str(tag).strip())
    seen: set[str] = set()
    existing = {tag.name.lower(): tag for tag in await NoteTagService.list_tags(db, user_id)}
    for name in names:
        clean = name.strip()[:40]
        key = clean.lower()
        if not clean or key in seen:
            continue
        seen.add(key)
        if len(seen) > 10:
            break
        tag = existing.get(key)
        if tag is None:
            tag = await NoteTagService.create_tag(db, user_id, clean)
            existing[key] = tag
        await NoteTagService.add_tag_to_note(db, note_id, tag.id, user_id)


def _related_titles(card: KnowledgeCard, target_note: Note | None) -> list[str]:
    titles: list[str] = []
    if target_note is not None and card.title.strip() != target_note.title:
        titles.append(target_note.title)
    return titles


async def compile_card(
    db: AsyncSession,
    user_id: uuid.UUID,
    card_id: uuid.UUID,
    *,
    mode: str = "new",
    note_id: uuid.UUID | None = None,
    folder_id: uuid.UUID | None = None,
    title: str | None = None,
    tags: list[str] | None = None,
) -> tuple[Note, dict]:
    """批准卡片 → 新建或合并笔记。重复调用返回已有笔记。"""
    result = await db.execute(
        select(KnowledgeCard).where(
            KnowledgeCard.id == card_id,
            KnowledgeCard.user_id == user_id,
        )
    )
    card = result.scalar_one_or_none()
    if card is None:
        raise ValueError("知识卡不存在")
    doc = await db.get(IngestDocument, card.document_id)
    if doc is None:
        raise ValueError("源文档不存在")

    if card.status in {"approved", "merged"} and card.note_id:
        note = await NoteService.get_note(db, card.note_id)
        if note is not None:
            return note, card.kb_target or {}

    if tags:
        payload = dict(card.payload or {})
        payload["tags"] = [str(tag).strip() for tag in tags if str(tag).strip()][:8]
        card.payload = payload
    if title:
        card.title = title.strip()[:200]

    target_note: Note | None = None
    target_id = note_id if mode == "merge" else None
    if mode == "merge":
        target_id = target_id or card.merge_target_note_id
        if target_id is None:
            raise ValueError("缺少合并目标笔记")
        target_note = await NoteService.get_note(db, target_id)
        if (
            target_note is None
            or target_note.is_deleted
            or target_note.created_by != user_id
        ):
            raise ValueError("合并目标笔记不存在")

    if folder_id is not None:
        folder = await db.get(NoteFolder, folder_id)
        if folder is None or folder.is_deleted or folder.user_id != user_id:
            raise ValueError("目标文件夹不存在")

    related = _related_titles(card, target_note)
    kb_target = build_kb_target(card, doc, related_titles=related)
    description = _description(card, kb_target)

    if target_note is not None:
        section = render_card_markdown(card, doc, related_titles=related)
        kb_target["mode"] = "merge"
        updated, error = await NoteService.append_text(
            db,
            target_note.id,
            user_id,
            f"\n\n## 更新 {_today()}\n\n{section}",
        )
        if updated is None:
            raise ValueError(error or "合并到笔记失败")
        await NoteService.update_note(
            db,
            target_note.id,
            {"description": description, "updated_by": user_id},
            change_summary=f"知识卡合并：{card.title}",
        )
        note = updated
        card.status = "merged"
        role = "merged"
    else:
        content = render_card_markdown(card, doc, related_titles=related)
        kb_target["mode"] = "new"
        kb_target["wikiBody"] = content
        note = await NoteService.create_note(
            db,
            {
                "title": card.title,
                "note_type": "markdown",
                "content": {"text": content},
                "description": description,
                "folder_id": folder_id,
                "created_by": user_id,
                "updated_by": user_id,
            },
        )
        card.status = "approved"
        role = "primary"

    await _add_tags(db, user_id, note.id, card)

    exists = await db.execute(
        select(NoteSource).where(
            NoteSource.note_id == note.id,
            NoteSource.document_id == doc.id,
        )
    )
    if exists.scalar_one_or_none() is None:
        db.add(NoteSource(note_id=note.id, document_id=doc.id, card_id=card.id, role=role))

    now = datetime.now(timezone.utc)
    card.note_id = note.id
    card.kb_target = kb_target
    card.decided_by = user_id
    card.decided_at = now
    doc.note_id = note.id
    doc.status = "merged" if role == "merged" else "approved"
    doc.reviewed_at = now
    doc.compiled_at = now
    await db.commit()
    await db.refresh(note)
    return note, kb_target
