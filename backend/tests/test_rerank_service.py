"""RAG 重排结果解析与降级测试。"""
from __future__ import annotations

import pytest

from app.services.ai.rerank_service import (
    local_lexical_rerank,
    parse_rerank_response,
    rerank,
)


def test_parse_cohere_style_results():
    payload = {
        "results": [
            {"index": 2, "relevance_score": 0.2},
            {"index": 0, "relevance_score": 0.9},
            {"index": 1, "relevance_score": 0.5},
        ]
    }
    assert parse_rerank_response(payload, 3) == [0, 1, 2]


def test_parse_jina_style_data_and_out_of_range():
    payload = {"data": [{"index": 1, "score": 0.8}, {"index": 9, "score": 1.0}]}
    assert parse_rerank_response(payload, 3) == [1]


def test_parse_invalid_payload_returns_none():
    assert parse_rerank_response({"results": "bad"}, 3) is None
    assert parse_rerank_response(None, 3) is None


def test_local_lexical_rerank_prefers_more_hits():
    documents = [
        "无关的午餐菜单",
        "部署回滚预案与演练步骤",
        "回滚脚本检查",
    ]
    order = local_lexical_rerank("部署回滚", documents)
    assert order is not None
    assert order[0] == 1
    assert 2 in order


def test_local_lexical_rerank_returns_none_without_hits():
    assert local_lexical_rerank("部署回滚", ["午餐菜单", "订票"]) is None


@pytest.mark.asyncio
async def test_rerank_disabled_returns_none():
    assert await rerank("查询", ["文档"]) is None
