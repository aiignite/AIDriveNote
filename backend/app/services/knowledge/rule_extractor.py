"""规则兜底抽取：不依赖模型，保证入库不中断。"""
from __future__ import annotations

import re
from types import SimpleNamespace

from app.models.knowledge import IngestDocument
from app.services.knowledge.keyword_rules import (
    extract_entities,
    extract_keywords,
    judge_knowledge_type,
)
from app.services.knowledge.schemas import CardDraft

_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+)$", re.MULTILINE)
_LIST_RE = re.compile(r"^\s*[-*+]\s+(.+)$", re.MULTILINE)
_H2_RE = re.compile(r"^##\s+(.+)$", re.MULTILINE)


def _first_heading(text: str) -> str:
    match = _HEADING_RE.search(text)
    return match.group(2).strip() if match else ""


def _summarize(text: str, limit: int = 320) -> str:
    paragraphs = [
        line.strip()
        for line in re.split(r"\n{2,}", text)
        if line.strip() and not line.strip().startswith("#")
    ]
    if not paragraphs:
        paragraphs = [line.strip() for line in text.splitlines() if line.strip()]
    summary = " ".join(paragraphs[:3]).strip()
    if len(summary) > limit:
        summary = summary[:limit].rstrip() + "…"
    return summary or text[:limit]


def _key_points(text: str, limit: int = 5) -> list[str]:
    candidates: list[str] = []
    for match in _HEADING_RE.finditer(text):
        if len(match.group(1)) >= 2:
            candidates.append(match.group(2).strip())
    for match in _LIST_RE.finditer(text):
        candidates.append(match.group(1).strip())
    result: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        if len(item) < 3 or item in seen:
            continue
        seen.add(item)
        result.append(item[:200])
        if len(result) >= limit:
            break
    return result


def build_rule_card(doc: IngestDocument) -> CardDraft:
    text = (doc.raw_text or "").strip()
    title = (doc.title or "").strip() or _first_heading(text) or "未命名文档"

    if not text:
        return CardDraft(
            title=title[:200],
            knowledge_type="note",
            summary="该文档暂无可提取文本（可能是扫描件、图片或加密文件），请查看原文后补充。",
            confidence="low",
            payload={
                "key_points": [],
                "keywords": [],
                "entities": [],
                "claims": [],
                "topic": "",
                "tags": [],
                "needs_review": True,
                "parse_meta": doc.parse_meta or {},
            },
            extractor="rule",
            prompt_version="rule-v1",
        )

    summary = _summarize(text)
    keywords = extract_keywords(text, 10)
    entities = extract_entities(text, 8)
    return CardDraft(
        title=title[:200],
        knowledge_type=judge_knowledge_type(title, text),  # type: ignore[arg-type]
        summary=summary,
        confidence="low",
        payload={
            "key_points": _key_points(text),
            "keywords": keywords,
            "entities": entities,
            "claims": [],
            "topic": "",
            "tags": keywords[:5],
            "needs_review": True,
            "truncated": bool((doc.parse_meta or {}).get("truncated")),
        },
        extractor="rule",
        prompt_version="rule-v1",
    )


def _split_h2_sections(text: str) -> list[tuple[str, str]]:
    matches = list(_H2_RE.finditer(text))
    if len(matches) < 2:
        return []
    sections: list[tuple[str, str]] = []
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections.append((match.group(1).strip(), text[start:end].strip()))
    return sections


def build_rule_cards(doc: IngestDocument, max_cards: int = 1) -> list[CardDraft]:
    """规则兜底；日报类邮件按 H2 拆成多张卡，其余文档保持一张。"""
    text = (doc.raw_text or "").strip()
    if (
        max_cards <= 1
        or not text
        or doc.source_type not in {"email", "web_clip"}
    ):
        return [build_rule_card(doc)]

    sections = _split_h2_sections(text)
    if len(sections) < 2:
        return [build_rule_card(doc)]

    cards: list[CardDraft] = []
    for heading, body in sections[:max_cards]:
        part = SimpleNamespace(
            title=f"{doc.title or '未命名文档'} · {heading}"[:200],
            raw_text=body,
            parse_meta=doc.parse_meta or {},
        )
        cards.append(build_rule_card(part))  # type: ignore[arg-type]
    return cards
