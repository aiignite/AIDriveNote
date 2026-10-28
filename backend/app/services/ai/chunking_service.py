"""笔记分块：把一篇笔记切成可嵌入、可定位检索的最小语义单元。"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Any

from app.services.note.rich_text_blocks import content_to_preview_text

DEFAULT_TARGET_CHARS = 600
DEFAULT_OVERLAP_CHARS = 80
MAX_CHUNK_CHARS = 1800


@dataclass
class NoteChunk:
    index: int
    content: str
    heading_path: str
    token_count: int
    is_summary: bool = False

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.content.encode("utf-8")).hexdigest()


_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")


def _flush(
    chunks: list[NoteChunk],
    buffer: list[str],
    heading_path: str,
) -> None:
    body = "\n".join(buffer).strip()
    if not body:
        return
    chunks.append(NoteChunk(
        index=len(chunks),
        content=body,
        heading_path=heading_path,
        # 粗略 token 估算：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token；
        # 这里只用于装配预算，不参与计费。
        token_count=max(1, len(body) // 2),
    ))


def _split_long_text(text: str, target: int, overlap: int) -> list[str]:
    """超长段落按字符窗口切分，保留 overlap 以便跨块召回。"""
    if len(text) <= target:
        return [text]
    pieces: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + target)
        piece = text[start:end].strip()
        if piece:
            pieces.append(piece)
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)
    return pieces


def _pack_paragraphs(paragraphs: list[str], target: int, overlap: int) -> list[str]:
    """把段落贪心装进 target 大小的块，块间带 overlap 尾巴。"""
    packed: list[str] = []
    buffer: list[str] = []
    size = 0
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) > target:
            if buffer:
                packed.append("\n".join(buffer))
                buffer, size = [], 0
            packed.extend(_split_long_text(para, target, overlap))
            continue
        if size + len(para) + 1 > target and buffer:
            packed.append("\n".join(buffer))
            tail = packed[-1][-overlap:] if overlap > 0 else ""
            buffer = [tail, para] if tail else [para]
            size = len(tail) + len(para) + 1
        else:
            buffer.append(para)
            size += len(para) + 1
    if buffer:
        packed.append("\n".join(buffer))
    return [p.strip() for p in packed if p.strip()]


def _markdown_sections(text: str) -> list[tuple[str, str]]:
    """按标题层级切节，返回 (heading_path, body)。"""
    sections: list[tuple[str, str]] = []
    stack: list[tuple[int, str]] = []
    buffer: list[str] = []

    def current_path() -> str:
        return " > ".join(title for _level, title in stack)

    for line in text.splitlines():
        match = _HEADING_RE.match(line.strip())
        if match:
            body = "\n".join(buffer).strip()
            if body:
                sections.append((current_path(), body))
            buffer = []
            level = len(match.group(1))
            title = match.group(2).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
            continue
        buffer.append(line)

    body = "\n".join(buffer).strip()
    if body:
        sections.append((current_path(), body))
    return sections


def _plain_sections(text: str) -> list[tuple[str, str]]:
    paragraphs = [p for p in re.split(r"\n{2,}", text) if p.strip()]
    if not paragraphs:
        paragraphs = [line for line in text.splitlines() if line.strip()]
    return [("", "\n\n".join(paragraphs))]


def chunk_note(
    title: str,
    content: dict[str, Any] | None,
    note_type: str,
    *,
    target_chars: int = DEFAULT_TARGET_CHARS,
    overlap_chars: int = DEFAULT_OVERLAP_CHARS,
    text_override: str | None = None,
) -> list[NoteChunk]:
    """把笔记内容切成块；空笔记返回空列表。

    ``text_override`` 用于正文不在 ``content`` 里的类型（文档笔记），
    由调用方从附表取出文本后传入。
    """
    text = (
        (text_override or "")[:200_000]
        if text_override is not None
        else content_to_preview_text(note_type, content or {}, max_chars=200_000)
    )
    if not text or not text.strip():
        return []

    sections = _markdown_sections(text) if note_type == "markdown" else _plain_sections(text)
    chunks: list[NoteChunk] = []
    for heading_path, body in sections:
        paragraphs = [p for p in re.split(r"\n{2,}", body) if p.strip()]
        if not paragraphs:
            paragraphs = [body]
        for piece in _pack_paragraphs(paragraphs, target_chars, overlap_chars):
            if len(piece) > MAX_CHUNK_CHARS:
                for sub in _split_long_text(piece, MAX_CHUNK_CHARS, overlap_chars):
                    chunks.append(NoteChunk(
                        index=len(chunks),
                        content=sub,
                        heading_path=heading_path,
                        token_count=max(1, len(sub) // 2),
                    ))
                continue
            chunks.append(NoteChunk(
                index=len(chunks),
                content=piece,
                heading_path=heading_path,
                token_count=max(1, len(piece) // 2),
            ))
    return chunks
