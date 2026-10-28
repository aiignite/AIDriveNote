"""录音纪要：结构化归一化与兜底渲染测试。"""
from __future__ import annotations

import uuid

import pytest

from app.services.note.recording.recording_insight_service import (
    generate_minutes,
    normalize_minutes,
    render_markdown,
)


def test_normalize_accepts_plain_strings_and_drops_empty_fields():
    minutes = normalize_minutes({
        "summary": " 本周完成部署 ",
        "decisions": ["上线时间定在周五", {"text": "预算通过", "time": 12.5}],
        "action_items": [{"task": "准备回滚预案", "owner": "张三"}, {"task": ""}],
        "chapters": [{"title": "部署", "start": 0, "end": 60}, {"title": ""}],
    })
    assert minutes["summary"] == "本周完成部署"
    assert len(minutes["decisions"]) == 2
    assert minutes["actionItems"][0]["owner"] == "张三"
    assert len(minutes["actionItems"]) == 1
    assert len(minutes["chapters"]) == 1


def test_render_markdown_has_sections_and_timestamps():
    markdown = render_markdown({
        "summary": "摘要",
        "decisions": [{"text": "通过预算", "time": 65}],
        "actionItems": [{"task": "写周报", "owner": "李四", "due": "周五", "time": 90}],
        "chapters": [{"title": "开场", "start": 0, "end": 30}],
    })
    assert "## 会议纪要" in markdown
    assert "### 决议" in markdown
    assert "01:05" in markdown
    assert "负责人：李四" in markdown
    assert "00:00–00:30 开场" in markdown


def test_render_markdown_without_content_is_still_valid():
    markdown = render_markdown(normalize_minutes(None))
    assert markdown.startswith("## 会议纪要")


@pytest.mark.asyncio
async def test_generate_minutes_without_transcript_raises(db_session):
    with pytest.raises(ValueError):
        await generate_minutes(db_session, uuid.uuid4(), uuid.uuid4())
