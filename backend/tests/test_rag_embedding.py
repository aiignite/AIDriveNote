"""语义检索基础设施：向量维度、HNSW 索引与嵌入后端解析。"""
from __future__ import annotations

import pytest

from app.config import get_settings
from app.services.ai import embedding_service
from app.services.ai.rag_v2_schema import HNSW_MAX_DIM, _ddl_statements


def test_rag_schema_ddl_follows_embedding_dim():
    """建表维度跟随配置；超过 pgvector HNSW 上限时不建索引（退回精确扫描）。"""
    small = " ".join(_ddl_statements(1024))
    assert "vector(1024)" in small
    assert "USING hnsw" in small

    large = " ".join(_ddl_statements(HNSW_MAX_DIM + 48))
    assert f"vector({HNSW_MAX_DIM + 48})" in large
    assert "USING hnsw" not in large


@pytest.mark.asyncio
async def test_embedding_backend_defaults_to_ollama(monkeypatch):
    """没配模型引用时走本地 Ollama，模型名回退到 OLLAMA_EMBED_MODEL。"""
    monkeypatch.setenv("EMBEDDING_PROVIDER", "ollama")
    monkeypatch.setenv("EMBEDDING_MODEL_REF", "")
    monkeypatch.setenv("EMBEDDING_MODEL", "")
    get_settings.cache_clear()
    try:
        backend = await embedding_service._resolve_backend()
        settings = get_settings()
        assert backend is not None
        kind, base_url, api_key, model = backend
        assert kind == "ollama"
        assert base_url == settings.OLLAMA_BASE_URL
        assert api_key == ""
        assert model == settings.OLLAMA_EMBED_MODEL
    finally:
        get_settings.cache_clear()
