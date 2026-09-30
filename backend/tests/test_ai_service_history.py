"""Tests for AI conversation history reconstruction."""
from __future__ import annotations

import pytest

from app.models.ai.ai import AIConversation, AIMessage
from app.services.ai.ai_service import AIService


@pytest.mark.asyncio
async def test_load_history_restores_tool_call_id_from_tool_calls(db_session, test_user):
    conv = AIConversation(user_id=test_user.id, title="测试", assistant_name="笔记助手")
    db_session.add(conv)
    await db_session.flush()

    db_session.add(AIMessage(conversation_id=conv.id, role="user", content="帮我查笔记"))
    db_session.add(AIMessage(
        conversation_id=conv.id,
        role="assistant",
        content="已查询",
        tool_calls=[{
            "id": "call_abc123",
            "type": "function",
            "function": {"name": "get_note", "arguments": {"note_id": "n1"}},
        }],
        tool_results=[{
            "tool": "get_note",
            "result": {"success": True, "title": "测试笔记"},
        }],
    ))
    await db_session.commit()

    history = await AIService.load_history(db_session, conv.id)
    tool_msgs = [m for m in history if m.role == "tool"]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "call_abc123"
    assert history[-1].role == "assistant"
    assert history[-1].content == "已查询"


@pytest.mark.asyncio
async def test_load_history_prefers_stored_tool_call_id(db_session, test_user):
    conv = AIConversation(user_id=test_user.id, title="测试", assistant_name="笔记助手")
    db_session.add(conv)
    await db_session.flush()

    db_session.add(AIMessage(
        conversation_id=conv.id,
        role="assistant",
        content="",
        tool_calls=[{"id": "call_old", "type": "function", "function": {"name": "get_note", "arguments": {}}}],
        tool_results=[{
            "tool": "get_note",
            "tool_call_id": "call_stored",
            "result": {"success": True},
        }],
    ))
    await db_session.commit()

    history = await AIService.load_history(db_session, conv.id)
    tool_msgs = [m for m in history if m.role == "tool"]
    assert tool_msgs[0].tool_call_id == "call_stored"


@pytest.mark.asyncio
async def test_load_history_expands_multi_tool_rounds(db_session, test_user):
    conv = AIConversation(user_id=test_user.id, title="多轮", assistant_name="笔记助手")
    db_session.add(conv)
    await db_session.flush()

    db_session.add(AIMessage(
        conversation_id=conv.id,
        role="assistant",
        content="设计完成",
        tool_calls=[
            {"id": "call_1", "type": "function", "function": {"name": "get_note", "arguments": {}}},
            {"id": "call_2", "type": "function", "function": {"name": "update_note", "arguments": {}}},
        ],
        tool_results=[
            {"tool": "get_note", "tool_call_id": "call_1", "result": {"success": True}},
            {"tool": "update_note", "tool_call_id": "call_2", "result": {"success": True, "preview": True}},
        ],
    ))
    await db_session.commit()

    history = await AIService.load_history(db_session, conv.id)
    roles = [m.role for m in history]
    assert roles == [
        "assistant", "tool", "assistant", "tool", "assistant",
    ]
    assert history[0].tool_calls and history[0].tool_calls[0]["id"] == "call_1"
    assert history[1].tool_call_id == "call_1"
    assert history[2].tool_calls and history[2].tool_calls[0]["id"] == "call_2"
    assert history[3].tool_call_id == "call_2"
    assert history[4].content == "设计完成"

