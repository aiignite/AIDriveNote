"""标签候选：优先复用既有标签，其次从正文提取高频词。

默认不调用 LLM：保存后立刻出候选，成本为零且结果稳定；用户仍需手动采纳，
符合「AI 提议、人来批准」的交互原则。开启 ``NOTE_TAG_SUGGEST_LLM`` 后，
先做启发式筛选，再由模型在候选内二次挑选（失败自动回退）。
"""
from __future__ import annotations

import json
import logging
import os
import re
import uuid
from collections import Counter

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.note import Note
from app.services.note.link_parser import build_search_text
from app.services.note.note_enhance_service import NoteTagService, note_preview_text

logger = logging.getLogger(__name__)

TAG_LLM_PROMPT = """你是标签整理助手。根据笔记内容，从候选标签中挑选 3-5 个最贴切的标签。
规则：
- 优先复用候选标签，只有候选完全不合适时才允许新增 1 个；
- 标签是名词或短语，2-8 个字，不要句子；
- 只输出 JSON：{"tags": ["标签1", "标签2"]}"""


def parse_llm_tags(raw: str, allowed: list[str], limit: int) -> list[str]:
    """解析模型返回的标签 JSON；只保留字符串并去重。"""
    match = re.search(r"\{.*\}", raw or "", re.DOTALL)
    if not match:
        return []
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return []
    tags = data.get("tags") if isinstance(data, dict) else None
    if not isinstance(tags, list):
        return []
    allowed_lower = {name.lower(): name for name in allowed}
    result: list[str] = []
    seen: set[str] = set()
    for item in tags:
        name = str(item).strip()
        if not name:
            continue
        canonical = allowed_lower.get(name.lower(), name)
        if canonical.lower() in seen:
            continue
        seen.add(canonical.lower())
        result.append(canonical)
        if len(result) >= limit:
            break
    return result


_STOPWORDS = {
    "我们", "你们", "他们", "这个", "那个", "可以", "需要", "进行", "通过",
    "以及", "但是", "如果", "因为", "所以", "已经", "没有", "一个", "什么",
    "自己", "现在", "时候", "问题", "内容", "笔记", "相关", "主要", "同时",
    "目前", "之后", "其中", "并且", "或者", "就是", "不是", "还是",
}

_TOKEN_RE = re.compile(r"[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_+-]{2,}")


async def _maybe_llm_rerank(
    db: AsyncSession,
    user_id: uuid.UUID,
    note: Note,
    results: list[dict],
    limit: int,
) -> list[dict]:
    """可选的模型二次筛选；任何失败都回退启发式结果。"""
    if (
        not get_settings().NOTE_TAG_SUGGEST_LLM
        or not results
        or os.getenv("AIDRIVE_TESTING") == "1"
    ):
        return results[:limit]
    allowed = [str(item["name"]) for item in results]
    try:
        from app.services.note.recording.llm_dispatch import dispatch_llm

        raw, _model = await dispatch_llm(
            db,
            system_prompt=TAG_LLM_PROMPT,
            user_prompt=(
                f"笔记标题：{note.title}\n"
                f"内容摘要：{note_preview_text(note, 400)}\n"
                f"候选标签：{', '.join(allowed)}"
            ),
            user_id=user_id,
            max_tokens=200,
            temperature=0.2,
        )
        picked = parse_llm_tags(raw, allowed, limit)
        if not picked:
            return results[:limit]
        by_name = {str(item["name"]).lower(): item for item in results}
        ordered = [by_name[name.lower()] for name in picked if name.lower() in by_name]
        for name in picked:
            if name.lower() not in by_name:
                ordered.append({
                    "name": name,
                    "color": None,
                    "existing": False,
                    "score": 0.5,
                })
        return ordered[:limit] or results[:limit]
    except Exception:  # noqa: BLE001 — 标签建议不能因模型失败而不可用
        logger.warning("标签建议 LLM 重排失败，回退启发式", exc_info=True)
        return results[:limit]


class TagSuggestionService:
    @staticmethod
    async def suggest(
        db: AsyncSession,
        user_id: uuid.UUID,
        note: Note,
        *,
        limit: int = 5,
    ) -> list[dict]:
        text = build_search_text(note.title, note.description, note.content, note.note_type)
        lowered = text.lower()
        existing_tags = await NoteTagService.list_tags(db, user_id)

        results: list[dict] = []
        used_names: set[str] = set()

        # 1) 已存在的标签名直接出现在正文里 → 最高优先级（防标签体系膨胀）
        for tag in existing_tags:
            if not tag.name:
                continue
            if tag.name.lower() in lowered and tag.name.lower() not in used_names:
                used_names.add(tag.name.lower())
                results.append({
                    "name": tag.name,
                    "color": tag.color,
                    "existing": True,
                    "score": 1.0,
                })
            if len(results) >= limit:
                return await _maybe_llm_rerank(db, user_id, note, results, limit)

        # 2) 正文高频词作为新标签候选
        tokens = [
            token for token in _TOKEN_RE.findall(text)
            if token not in _STOPWORDS and len(token) >= 2
        ]
        for token, count in Counter(tokens).most_common(40):
            key = token.lower()
            if key in used_names:
                continue
            # 去掉已被现有标签覆盖的候选（例如已有「项目」，不再提「项目管」）
            if any(key in name or name in key for name in used_names):
                continue
            used_names.add(key)
            results.append({
                "name": token,
                "color": None,
                "existing": False,
                "score": float(count),
            })
            if len(results) >= limit:
                break
        return await _maybe_llm_rerank(db, user_id, note, results, limit)
