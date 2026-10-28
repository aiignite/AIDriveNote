"""RAG v2 分块与降级行为的回归测试。"""
from __future__ import annotations

import pytest

from app.services.ai.chunking_service import chunk_note


def test_markdown_chunks_track_heading_path():
    text = "# 第一章\n\n第一段内容。" * 1 + "\n\n" + "填充" * 400 + "\n\n## 小节\n\n小节下的结论。"
    chunks = chunk_note("测试笔记", {"text": text}, "markdown", target_chars=300, overlap_chars=20)
    assert chunks
    assert any(chunk.heading_path.startswith("第一章") for chunk in chunks)
    assert any("小节下的结论" in chunk.content for chunk in chunks)
    assert [chunk.index for chunk in chunks] == list(range(len(chunks)))


def test_long_paragraph_is_split_with_overlap():
    body = "甲乙丙丁" * 500
    chunks = chunk_note("长文", {"text": body}, "markdown", target_chars=200, overlap_chars=40)
    assert len(chunks) > 1
    assert all(len(chunk.content) <= 1800 for chunk in chunks)
    # 相邻块应有重叠内容，避免答案恰好被切在边界
    first_tail = chunks[0].content[-20:]
    assert first_tail in chunks[1].content


def test_rich_text_uses_block_preview():
    content = {
        "blocks": [
            {"type": "paragraph", "props": {}, "content": [{"type": "text", "text": "第一段"}]},
            {"type": "paragraph", "props": {}, "content": [{"type": "text", "text": "第二段"}]},
        ],
    }
    chunks = chunk_note("富文本", content, "rich_text", target_chars=200)
    joined = "\n".join(chunk.content for chunk in chunks)
    assert "第一段" in joined and "第二段" in joined


def test_flowchart_labels_are_chunked():
    content = {"xml": '<mxCell value="开始"/><mxCell value="审批"/>'}
    chunks = chunk_note("流程", content, "flowchart")
    assert chunks
    assert "审批" in chunks[0].content


def test_empty_note_produces_no_chunks():
    assert chunk_note("空", {}, "markdown") == []


@pytest.mark.asyncio
async def test_rag_v2_is_unavailable_on_sqlite_and_falls_back(db_session, test_user):
    """SQLite 下 v2 应返回 None，由 v1 接管，而不是抛错。"""
    from app.services.ai.rag_v2_service import RagV2Service

    result = await RagV2Service.build_context(
        db_session, test_user.id, "任意问题", top_k=5,
    )
    assert result is None
