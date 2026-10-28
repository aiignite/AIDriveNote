"""相关笔记、建议链接与标签候的回归测试。"""
from __future__ import annotations

import pytest

from app.services.note.note_service import NoteService
from app.services.note.note_enhance_service import NoteTagService


async def _create(db, user, title: str, text: str):
    return await NoteService.create_note(db, {
        "title": title,
        "note_type": "markdown",
        "content": {"text": text},
        "created_by": user.id,
        "updated_by": user.id,
    })


@pytest.mark.asyncio
async def test_related_falls_back_to_shared_tags_and_tracks_links(db_session, test_user):
    from app.services.ai.related_service import RelatedNoteService

    source = await _create(db_session, test_user, "项目周会", "本周进度与风险")
    target = await _create(db_session, test_user, "项目复盘", "复盘结论与改进项")

    tag = await NoteTagService.create_tag(db_session, test_user.id, "项目A")
    await NoteTagService.add_tag_to_note(db_session, source.id, tag.id, test_user.id)
    await NoteTagService.add_tag_to_note(db_session, target.id, tag.id, test_user.id)

    related = await RelatedNoteService.related(db_session, test_user.id, source, limit=5)
    assert any(item["id"] == str(target.id) for item in related)
    assert all(item["linked"] is False for item in related)

    await NoteService.append_text(
        db_session, source.id, test_user.id, f"\n\n[[{target.title}]]",
    )
    refreshed = await NoteService.get_note(db_session, source.id)
    related_after = await RelatedNoteService.related(
        db_session, test_user.id, refreshed, limit=5,
    )
    assert any(item["id"] == str(target.id) and item["linked"] for item in related_after)


def test_parse_llm_tags_maps_existing_names_and_caps():
    from app.services.note.tag_suggestion_service import parse_llm_tags

    raw = '```json\n{"tags": ["部署", "新词", "部署", "第三个"]}\n```'
    assert parse_llm_tags(raw, ["部署"], 2) == ["部署", "新词"]


def test_parse_llm_tags_handles_garbage():
    from app.services.note.tag_suggestion_service import parse_llm_tags

    assert parse_llm_tags("not json", [], 3) == []
    assert parse_llm_tags('{"tags": "x"}', [], 3) == []


@pytest.mark.asyncio
async def test_related_excludes_self(db_session, test_user):
    from app.services.ai.related_service import RelatedNoteService

    note = await _create(db_session, test_user, "唯一笔记", "没有任何相关笔记")
    related = await RelatedNoteService.related(db_session, test_user.id, note, limit=5)
    assert all(item["id"] != str(note.id) for item in related)


@pytest.mark.asyncio
async def test_tag_suggestions_prefer_existing_tags(db_session, test_user):
    from app.services.note.tag_suggestion_service import TagSuggestionService

    await NoteTagService.create_tag(db_session, test_user.id, "部署")
    note = await _create(db_session, test_user, "上线记录", "部署 完成，部署 回滚预案已确认")

    suggestions = await TagSuggestionService.suggest(db_session, test_user.id, note, limit=5)
    assert suggestions
    assert suggestions[0]["name"] == "部署"
    assert suggestions[0]["existing"] is True
    assert len(suggestions) <= 5


@pytest.mark.asyncio
async def test_tag_suggestions_extract_keywords_when_no_existing_match(db_session, test_user):
    from app.services.note.tag_suggestion_service import TagSuggestionService

    note = await _create(
        db_session, test_user, "客户反馈",
        "客户反馈 客户反馈 客户反馈 交付质量 交付质量 响应速度",
    )
    suggestions = await TagSuggestionService.suggest(db_session, test_user.id, note, limit=3)
    names = [item["name"] for item in suggestions]
    assert any("客户反馈" in name or "交付质量" in name for name in names)
