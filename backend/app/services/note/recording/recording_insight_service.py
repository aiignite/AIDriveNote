"""录音转写 → 结构化纪要（摘要 / 决议 / 行动项 / 章节）。"""
from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.recording import NoteTranscript

logger = logging.getLogger(__name__)

MINUTES_PROMPT = """你是会议纪要助手。根据带时间戳的转写内容，输出严格的 JSON（不要输出 markdown 代码块）：
{
  "summary": "150 字以内的中文摘要",
  "decisions": [{"text": "决议内容", "time": 12.5}],
  "action_items": [{"task": "待办事项", "owner": "负责人或空字符串", "due": "期限或空字符串", "time": 34.0}],
  "chapters": [{"title": "章节标题", "start": 0, "end": 120}]
}
要求：
- 只记录转写中明确出现的信息，不臆造负责人和期限；
- time/start/end 单位为秒，无法确定时省略该字段；
- 没有决议或行动项时返回空数组。"""


def _format_time(seconds: float) -> str:
    total = max(0, int(seconds or 0))
    return f"{total // 60:02d}:{total % 60:02d}"


def _extract_json(text: str) -> dict[str, Any] | None:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE | re.MULTILINE)
    match = re.search(r"\{.*\}", cleaned, re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def normalize_minutes(
    data: dict[str, Any] | None,
    *,
    fallback_summary: str = "",
) -> dict[str, Any]:
    """把模型输出收敛为稳定结构；字段缺失时回退为空列表。"""
    data = data or {}
    summary = str(data.get("summary") or fallback_summary or "").strip()

    def _list(name: str) -> list[dict[str, Any]]:
        raw = data.get(name)
        if not isinstance(raw, list):
            return []
        result: list[dict[str, Any]] = []
        for item in raw:
            if isinstance(item, str):
                item = {"text" if name == "decisions" else "task": item}
            if not isinstance(item, dict):
                continue
            entry = {key: value for key, value in item.items() if value not in (None, "")}
            if entry:
                result.append(entry)
        return result

    chapters = []
    for chapter in _list("chapters"):
        if chapter.get("title"):
            chapters.append(chapter)

    return {
        "summary": summary,
        "decisions": _list("decisions"),
        "actionItems": _list("action_items"),
        "chapters": chapters,
    }


def render_markdown(minutes: dict[str, Any]) -> str:
    lines: list[str] = ["## 会议纪要", ""]
    if minutes.get("summary"):
        lines += [str(minutes["summary"]), ""]
    decisions = minutes.get("decisions") or []
    if decisions:
        lines.append("### 决议")
        for item in decisions:
            time_hint = f"（{_format_time(item['time'])}）" if item.get("time") is not None else ""
            lines.append(f"- {item.get('text', '')}{time_hint}")
        lines.append("")
    actions = minutes.get("actionItems") or []
    if actions:
        lines.append("### 行动项")
        for item in actions:
            parts = [str(item.get("task", ""))]
            if item.get("owner"):
                parts.append(f"负责人：{item['owner']}")
            if item.get("due"):
                parts.append(f"期限：{item['due']}")
            if item.get("time") is not None:
                parts.append(_format_time(item["time"]))
            lines.append("- " + "；".join(parts))
        lines.append("")
    chapters = minutes.get("chapters") or []
    if chapters:
        lines.append("### 章节")
        for chapter in chapters:
            start = chapter.get("start")
            end = chapter.get("end")
            if start is not None and end is not None:
                lines.append(f"- {_format_time(start)}–{_format_time(end)} {chapter.get('title', '')}")
            else:
                lines.append(f"- {chapter.get('title', '')}")
    return "\n".join(lines).strip()


async def generate_minutes(
    db: AsyncSession,
    user_id: uuid.UUID,
    recording_id: uuid.UUID,
    *,
    model: str | None = None,
) -> dict[str, Any]:
    result = await db.execute(
        select(NoteTranscript)
        .where(
            NoteTranscript.recording_id == recording_id,
            NoteTranscript.is_deleted == False,  # noqa: E712
        )
        .order_by(NoteTranscript.segment_index),
    )
    segments = list(result.scalars().all())
    if not segments:
        raise ValueError("这条录音还没有转写内容")

    transcript_text = "\n".join(
        f"[{_format_time(seg.start_time)}] "
        + (f"{seg.speaker_label}: " if seg.speaker_label else "")
        + (seg.text or "")
        for seg in segments
    )
    # 控制单次成本：超长会议保留开头与结尾各一段（模型通常关注结论）
    if len(transcript_text) > 20000:
        transcript_text = transcript_text[:12000] + "\n…（中间省略）…\n" + transcript_text[-8000:]

    from app.services.note.recording.llm_dispatch import dispatch_llm

    try:
        raw, model_name = await dispatch_llm(
            db,
            system_prompt=MINUTES_PROMPT,
            user_prompt=f"转写内容：\n{transcript_text}",
            user_id=user_id,
            model=model,
            max_tokens=2000,
            temperature=0.2,
        )
        minutes = normalize_minutes(
            _extract_json(raw),
            fallback_summary=(segments[0].text or "")[:200],
        )
    except Exception as exc:  # noqa: BLE001 — 模型不可用时给出规则层兜底
        logger.warning("纪要生成失败，使用规则兜底：%s", exc)
        minutes = normalize_minutes(None, fallback_summary=(segments[0].text or "")[:200])
        model_name = None

    minutes["markdown"] = render_markdown(minutes)
    minutes["model"] = model_name
    return minutes
