"""RAG 重排：对接标准 cross-encoder rerank HTTP 接口。

协议兼容 Jina / Cohere / BGE 服务常见的两种返回：

- ``{"results": [{"index": 0, "relevance_score": 0.9}, ...]}``
- ``{"data": [{"index": 0, "score": 0.9}, ...]}``
"""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

_TOKEN_RE = re.compile(r"[\u4e00-\u9fff]{2}|[A-Za-z0-9_+-]{2,}")


def local_lexical_rerank(query: str, documents: list[str]) -> list[int] | None:
    """无需外部模型的本地重排：按查询词命中率 + 位置加权排序。

    作为 cross-encoder 未配置/不可用时的兜底，比纯 RRF 更贴合字面相关度。
    """
    tokens = list(dict.fromkeys(_TOKEN_RE.findall((query or "").lower())))
    if not tokens or not documents:
        return None
    scored: list[tuple[int, float]] = []
    for index, document in enumerate(documents):
        text = (document or "").lower()
        if not text:
            continue
        hits = 0.0
        for token in tokens:
            position = text.find(token)
            if position >= 0:
                # 命中越靠前权重越高
                hits += 1.0 + max(0.0, 0.2 - position / max(len(text), 1))
        if hits > 0:
            scored.append((index, hits / len(tokens)))
    if not scored:
        return None
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return [index for index, _score in scored]


def parse_rerank_response(payload: Any, candidate_count: int) -> list[int] | None:
    """解析服务返回，得到按相关度降序的原始索引。"""
    if not isinstance(payload, dict):
        return None
    raw = payload.get("results")
    if not isinstance(raw, list):
        raw = payload.get("data")
    if not isinstance(raw, list):
        return None
    scored: list[tuple[int, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index"))
            score = float(item.get("relevance_score", item.get("score")))
        except (TypeError, ValueError):
            continue
        if 0 <= index < candidate_count:
            scored.append((index, score))
    if not scored:
        return None
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return [index for index, _score in scored]


async def rerank(query: str, documents: list[str]) -> list[int] | None:
    """返回重排后的索引；未启用返回 None（调用方保留原顺序）。

    启用但未配置 ``RERANK_URL`` 时使用本地词法重排；HTTP 服务失败也回退本地。
    """
    settings = get_settings()
    if not settings.RERANK_ENABLED or not documents:
        return None
    if not settings.RERANK_URL:
        return local_lexical_rerank(query, documents)
    payload = {
        "model": settings.RERANK_MODEL,
        "query": query,
        "documents": documents,
        "top_n": len(documents),
    }
    try:
        async with httpx.AsyncClient(timeout=settings.RERANK_TIMEOUT) as client:
            response = await client.post(settings.RERANK_URL, json=payload)
            response.raise_for_status()
        order = parse_rerank_response(response.json(), len(documents))
        return order or local_lexical_rerank(query, documents)
    except Exception:  # noqa: BLE001 — 重排失败不能影响检索
        logger.warning("RAG 重排调用失败，回退本地词法重排", exc_info=True)
        return local_lexical_rerank(query, documents)
