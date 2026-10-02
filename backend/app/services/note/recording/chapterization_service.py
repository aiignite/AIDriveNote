"""转写章节化 + 关键词抽取。

轻量、基于规则的实现，无需 LLM 调用。对于一条录音的每个
``NoteTranscript`` 行：

1. **章节** —— 每约 60 秒连续语音成为一个章节；说话人变化也会形成新的
   章节边界。章节标题取该章节内最长的文本分段，截断到 18 字。

2. **关键词** —— 基于词频抽取（含一份小型中文停用词表）。二元组
   出现 ≥ 2 次时优先。刻意不引入 jieba 依赖。

本服务由 :class:`NoteTranscriptionService` 在 Whisper 完成后调用，
把 ``chapter_id`` / ``chapter_title`` / ``keywords`` 列写回已有行。
"""
from __future__ import annotations

import logging
import re
import uuid
from collections import Counter
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.recording import NoteTranscript

logger = logging.getLogger(__name__)


CHAPTER_WINDOW_SECONDS = 60.0
TITLE_MAX_LEN = 18


# ── 60s 章节切分（轻量规则） ────────────────────────────────────────────


def _chapter_title(idx: int, text: str) -> str:
    """由章节内最长文本生成 ``§N 摘要`` 形式的标题。"""
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return f"§{idx} 章节 {idx}"
    snippet = cleaned[:TITLE_MAX_LEN]
    if len(cleaned) > TITLE_MAX_LEN:
        snippet += "…"
    return f"§{idx} {snippet}"


def compute_chapter_assignments(
    segments: list[NoteTranscript],
    window_seconds: float = CHAPTER_WINDOW_SECONDS,
) -> dict[int, tuple[int, str]]:
    """把每个分段分配到章节，并生成 {chapter_id: title} 映射。

    返回 ``{segment_index: (chapter_id, chapter_title)}``，调用方可直接持久化。
    """
    if not segments:
        return {}

    assignments: dict[int, tuple[int, str]] = {}
    chapter_start_ts: float = segments[0].start_time
    chapter_id = 0
    chapter_texts: list[str] = []
    chapter_segment_indices: list[int] = []

    def _finalise() -> str:
        seed = max(chapter_texts, key=len, default="")
        return _chapter_title(chapter_id, seed)

    for seg in segments:
        timed_out = (seg.start_time - chapter_start_ts) > window_seconds
        if timed_out and chapter_segment_indices:
            title = _finalise()
            for idx in chapter_segment_indices:
                assignments[idx] = (chapter_id, title)
            chapter_id += 1
            chapter_texts = []
            chapter_segment_indices = []
            chapter_start_ts = seg.start_time
        if not chapter_segment_indices:
            chapter_id = chapter_id + 1 if chapter_segment_indices == [] and chapter_id >= 1 else 1
            # 首段 → 从章节 1 开始
            if not assignments:
                chapter_id = 1
            else:
                # 计算下一个章节 id
                chapter_id = max(c for c, _ in assignments.values()) + 1
        chapter_segment_indices.append(seg.segment_index)
        if seg.text:
            chapter_texts.append(seg.text)

    if chapter_segment_indices:
        title = _finalise()
        for idx in chapter_segment_indices:
            assignments[idx] = (chapter_id, title)

    return assignments


# ── 关键词提取（无需 LLM / jieba） ──────────────────────────────────────

# 极简中文停用词表（只列最常见的）
_STOPWORDS = set(
    "的 了 是 在 我 你 他 她 它 们 和 与 及 或 也 都 就 还 但 而 "
    "对 这 那 一个 一些 那个 这么 那么 上 下 里 外 中 内"
    "我们 你们 他们 她们 它们 自己 因为 所以 但是 如果 那么 然后"
    "the a an is are was were of to in for on at by with from and or but not"
    " be have has do does"
    "这 那 哪 什么 怎么 怎样 为什么 多少 几个 哪 吗 呢 吧 啊 哦 嗯 哈"
    "大家 今天 昨天 明天 现在 这儿 那儿 这里 那里 啊 呢"
    "然后 因为 所以 但是 如果 没有 不是 可以 能够 需要 应该"
    "已经 还是 一些 这个 那个 这种 那种 这样 那样"
    "好的 行 没问题 可以啊 好的吧 嗯 哦 哎 唉 哈哈 哈哈哈"
    "的 是 在 了 不 和 有 也 就 都 还 但 而 或 及 与"
    "你 我 他 她 它 们 我们 你们 他们"
    "这个 那个 这些 那些"
    "一 二 三 四 五 六 七 八 九 十"
    "0 1 2 3 4 5 6 7 8 9"
    "啊 呀 吧 吗 嗯 哦 哈 哎 嘿 唉 嗨 哟 呐 呸 嘘"
    " 进行 一次 一些 上面 下面"
    " 0 1 2 3 4 5 6 7 8 9".split()
)

# 单字停用
_CHAR_NOISE = set("的了是在不和有也这就人都一个上下来到时说")


def extract_keywords(
    segments: Iterable[NoteTranscript],
    top_n: int = 8,
    min_len: int = 2,
) -> list[str]:
    """中文词频关键词抽取。

    策略：去停用词 → 按中英文词边界切分 → 统计一元 + 二元词频 → 返回 Top-N。
    """
    counter: Counter = Counter()
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        for tok in _tokenize(text):
            if len(tok) < min_len:
                continue
            if tok in _STOPWORDS:
                continue
            if all(c in _CHAR_NOISE for c in tok):
                continue
            counter[tok] += 1

    bigram_counter: Counter = Counter()
    for seg in segments:
        text = (seg.text or "").strip()
        for i, ch in enumerate(text):
            if i + 1 < len(text) and _is_chinese(ch) and _is_chinese(text[i + 1]):
                bg = text[i : i + 2]
                if bg in _STOPWORDS or any(c in _CHAR_NOISE for c in bg):
                    continue
                bigram_counter[bg] += 1

    keywords: list[str] = []
    for bg, cnt in bigram_counter.most_common(top_n * 2):
        if cnt >= 2 and bg not in keywords:
            keywords.append(bg)
        if len(keywords) >= top_n:
            break
    if len(keywords) < top_n:
        for tok, _ in counter.most_common(top_n * 2):
            if tok not in keywords:
                keywords.append(tok)
            if len(keywords) >= top_n:
                break
    return keywords[:top_n]


def _is_chinese(ch: str) -> bool:
    """判断字符是否属于中文 CJK 区段。"""
    cp = ord(ch)
    return 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF


def _tokenize(text: str) -> list[str]:
    """把文本切分为中文单字 token 与英文/数字整词 token。"""
    out: list[str] = []
    buf: list[str] = []
    for ch in text:
        if _is_chinese(ch):
            if buf:
                out.append("".join(buf))
                buf = []
            out.append(ch)
        elif ch.isalnum():
            buf.append(ch)
        else:
            if buf:
                out.append("".join(buf))
                buf = []
    if buf:
        out.append("".join(buf))
    return out


# ── 持久化 ─────────────────────────────────────────────────────────────


async def apply_chapters_and_keywords(
    db: AsyncSession,
    recording_id: uuid.UUID,
) -> int:
    """重新计算一条录音的章节 + 关键词并写回。

    返回被更新的分段数量。
    """
    stmt = (
        select(NoteTranscript)
        .where(
            NoteTranscript.recording_id == recording_id,
            NoteTranscript.is_deleted == False,  # noqa: E712
        )
        .order_by(NoteTranscript.segment_index.asc())
    )
    rows = list((await db.execute(stmt)).scalars().all())
    if not rows:
        return 0

    assignments = compute_chapter_assignments(rows)
    keywords = extract_keywords(rows)

    for seg in rows:
        chapter_id, title = assignments.get(seg.segment_index, (None, None))
        seg.chapter_id = chapter_id
        seg.chapter_title = title

    # 关键词只对每章首条 segment 写（节省空间）
    first_seg_idx_by_chapter: dict[int, int] = {}
    for seg in rows:
        if seg.chapter_id is not None and seg.chapter_id not in first_seg_idx_by_chapter:
            first_seg_idx_by_chapter[seg.chapter_id] = seg.segment_index
    for seg in rows:
        if seg.chapter_id is not None and first_seg_idx_by_chapter.get(seg.chapter_id) == seg.segment_index:
            seg.keywords = keywords
        else:
            seg.keywords = None

    await db.commit()
    return len(rows)