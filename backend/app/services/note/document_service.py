"""文档笔记服务：创建笔记、抽取正文、元数据与删除/复制。"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from uuid import UUID

import anyio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.note.document import NoteDocument
from app.models.note.note import Note
from app.services.knowledge.parsing.base import ParsedDocument
from app.services.knowledge.parsing.registry import parse_bytes
from app.services.note import document_storage
from app.services.note.document_storage import StoredDocument
from app.services.note.note_service import NoteService

logger = logging.getLogger(__name__)

# 2 核部署机：同一时刻只允许一个文档解析，避免 PDF/OCR 把 CPU 打满。
_PARSE_LOCK = threading.Lock()


def _parse_sync(data: bytes, filename: str, mime: str) -> ParsedDocument:
    with _PARSE_LOCK:
        return parse_bytes(
            data,
            filename=filename,
            mime=mime,
            allow_ocr=False,
        )


async def parse_document_bytes(data: bytes, filename: str, mime: str) -> ParsedDocument:
    return await anyio.to_thread.run_sync(lambda: _parse_sync(data, filename, mime))


def page_count_from_meta(ext: str, meta: dict) -> int | None:
    if ext == ".pdf":
        return meta.get("total_pages") or meta.get("pages")
    if ext == ".pptx":
        return meta.get("slides")
    if ext == ".xlsx":
        return meta.get("sheets")
    return None


def _default_title(filename: str) -> str:
    stem = Path(filename or "").stem.strip()
    return (stem or "文档")[:200]


def _clean_meta(meta: dict) -> dict:
    allowed = {"parser", "sheets", "sheet_names", "slides", "total_pages", "pages", "truncated"}
    return {key: value for key, value in (meta or {}).items() if key in allowed}


async def _apply_parsed(
    doc: NoteDocument,
    parsed: ParsedDocument | None,
    *,
    error: str | None = None,
) -> None:
    if parsed is None:
        doc.extract_status = "failed" if error else "skipped"
        doc.extract_error = (error or "")[:1000] or None
        return
    doc.extracted_text = parsed.text or None
    doc.meta = {**_clean_meta(parsed.meta), "parser": parsed.parser}
    doc.page_count = page_count_from_meta(doc.ext, parsed.meta)
    doc.extract_status = "ok"
    doc.extract_error = None


async def _read_stored_bytes(doc: NoteDocument) -> bytes | None:
    path = document_storage.resolve_path(doc.storage_path)
    if path is None:
        return None
    return await anyio.to_thread.run_sync(path.read_bytes)


async def create_document_note(
    db: AsyncSession,
    user_id: UUID,
    *,
    data: bytes,
    filename: str,
    folder_id: UUID | None = None,
    title: str | None = None,
    description: str | None = None,
) -> tuple[Note, NoteDocument]:
    """上传字节 → 落盘 → 建文档笔记 → 抽取正文。"""
    stored = document_storage.store(data, filename)
    return await _create_with_stored(
        db,
        user_id,
        stored,
        filename=filename,
        folder_id=folder_id,
        title=title,
        description=description,
        data=data,
    )


async def create_document_note_from_stored(
    db: AsyncSession,
    user_id: UUID,
    *,
    stored: StoredDocument,
    filename: str,
    folder_id: UUID | None = None,
    title: str | None = None,
    description: str | None = None,
    parsed_text: str | None = None,
    parsed_meta: dict | None = None,
    parser: str | None = None,
) -> tuple[Note, NoteDocument]:
    """KB / ingest 已落盘或已解析时复用同一建笔记逻辑。"""
    parsed = None
    if parsed_text is not None:
        parsed = ParsedDocument(
            text=parsed_text,
            parser=parser or "external",
            meta=dict(parsed_meta or {}),
        )
    return await _create_with_stored(
        db,
        user_id,
        stored,
        filename=filename,
        folder_id=folder_id,
        title=title,
        description=description,
        data=None,
        parsed=parsed,
    )


async def _create_with_stored(
    db: AsyncSession,
    user_id: UUID,
    stored: StoredDocument,
    *,
    filename: str,
    folder_id: UUID | None,
    title: str | None,
    description: str | None,
    data: bytes | None,
    parsed: ParsedDocument | None = None,
) -> tuple[Note, NoteDocument]:
    clean_name = document_storage.safe_file_name(filename)
    if not Path(clean_name).suffix:
        clean_name = f"{clean_name}{stored.ext}"
    note = await NoteService.create_note(db, {
        "title": (title or _default_title(clean_name))[:200],
        "note_type": "document",
        "content": None,
        "folder_id": folder_id,
        "description": description,
        "created_by": user_id,
        "updated_by": user_id,
    })
    doc = NoteDocument(
        note_id=note.id,
        file_name=clean_name,
        mime=stored.mime,
        ext=stored.ext,
        size_bytes=stored.size_bytes,
        sha256=stored.sha256,
        storage_path=stored.storage_path,
        etag=stored.sha256,
        meta={},
        extract_status="pending",
    )
    db.add(doc)
    await db.commit()

    if stored.viewable and parsed is None:
        try:
            payload = data if data is not None else await _read_stored_bytes(doc)
            if payload is None:
                await _apply_parsed(doc, None, error="原文件缺失")
            else:
                parsed = await parse_document_bytes(payload, clean_name, stored.mime)
                await _apply_parsed(doc, parsed)
        except Exception as exc:  # noqa: BLE001 — 解析失败不应阻断导入
            logger.warning("文档解析失败 %s: %s", clean_name, exc)
            await _apply_parsed(doc, None, error=str(exc))
    elif not stored.viewable:
        await _apply_parsed(doc, None)
    else:
        await _apply_parsed(doc, parsed)

    await db.commit()
    await db.refresh(doc)

    refreshed = await NoteService.get_note(db, note.id)
    if refreshed is not None:
        # 多次 commit 后 server_default 列可能处于过期状态，异步下不能隐式懒加载
        await db.refresh(refreshed)
        from app.services.note.note_enhance_service import NoteSearchService

        await NoteSearchService.update_search_fields(db, refreshed)
        await db.refresh(refreshed)
        from app.services.ai.embedding_service import schedule_note_embedding

        schedule_note_embedding(note.id)

    return refreshed or note, doc


async def get_document(db: AsyncSession, note_id: UUID) -> NoteDocument | None:
    result = await db.execute(select(NoteDocument).where(NoteDocument.note_id == note_id))
    return result.scalar_one_or_none()


async def get_document_meta_map(
    db: AsyncSession, note_ids: list[UUID],
) -> dict[str, NoteDocument]:
    """批量取文档元数据，显式排除 deferred 的 extracted_text。"""
    if not note_ids:
        return {}
    from sqlalchemy.orm import load_only

    result = await db.execute(
        select(NoteDocument)
        .options(
            load_only(
                NoteDocument.note_id,
                NoteDocument.file_name,
                NoteDocument.mime,
                NoteDocument.ext,
                NoteDocument.size_bytes,
                NoteDocument.sha256,
                NoteDocument.storage_path,
                NoteDocument.page_count,
                NoteDocument.etag,
                NoteDocument.meta,
                NoteDocument.extract_status,
            ),
        )
        .where(NoteDocument.note_id.in_(note_ids)),
    )
    return {str(row.note_id): row for row in result.scalars().all()}


async def get_extracted_text(db: AsyncSession, note_id: UUID) -> str | None:
    result = await db.execute(
        select(NoteDocument.extracted_text).where(NoteDocument.note_id == note_id),
    )
    return result.scalar_one_or_none()


async def duplicate_document(db: AsyncSession, source_note_id: UUID, target_note_id: UUID) -> None:
    source = await get_document(db, source_note_id)
    if source is None:
        return
    # extracted_text 是 deferred 列，必须显式查询，不能在同步属性访问时懒加载
    extracted_text = (
        await db.execute(
            select(NoteDocument.extracted_text).where(
                NoteDocument.note_id == source_note_id,
            ),
        )
    ).scalar_one_or_none()
    db.add(NoteDocument(
        note_id=target_note_id,
        file_name=source.file_name,
        mime=source.mime,
        ext=source.ext,
        size_bytes=source.size_bytes,
        sha256=source.sha256,
        storage_path=source.storage_path,
        page_count=source.page_count,
        etag=source.etag,
        meta=dict(source.meta or {}),
        extract_status=source.extract_status,
        extract_error=source.extract_error,
        extracted_text=extracted_text,
    ))
    await db.commit()

    # 副本的检索/向量字段需要基于同一份文档正文重建
    from app.models.note.note import Note

    result = await db.execute(
        select(Note)
        .where(Note.id == target_note_id)
        .execution_options(populate_existing=True),
    )
    note = result.scalar_one_or_none()
    if note is not None:
        from app.services.ai.embedding_service import schedule_note_embedding
        from app.services.note.note_enhance_service import NoteSearchService

        await NoteSearchService.update_search_fields(db, note)
        schedule_note_embedding(target_note_id)


async def delete_document_for_note(db: AsyncSession, note_id: UUID) -> None:
    """永久删除时清理行与磁盘文件；调用方需先确认笔记将被物理删除。"""
    doc = await get_document(db, note_id)
    if doc is None:
        return
    sha, ext = doc.sha256, doc.ext
    await db.delete(doc)
    await db.commit()
    try:
        await document_storage.delete_if_unreferenced(db, sha, ext)
    except Exception:  # noqa: BLE001 — 文件清理失败不阻断删笔记
        logger.warning("文档文件清理失败: %s", doc.storage_path, exc_info=True)


def build_document_meta(doc: NoteDocument) -> dict:
    allowed = document_storage.ALLOWED_DOCUMENTS.get(doc.ext)
    return {
        "file_name": doc.file_name,
        "mime": doc.mime,
        "ext": doc.ext,
        "size_bytes": doc.size_bytes,
        "page_count": doc.page_count,
        "etag": doc.etag,
        "viewable": bool(allowed and allowed[1]),
        "extract_status": doc.extract_status,
    }


def preview_text(doc: NoteDocument, max_len: int = 120) -> str:
    suffix = doc.ext.lstrip(".").upper() or "FILE"
    parts = [suffix]
    if doc.page_count:
        if doc.ext == ".xlsx":
            unit = " 个工作表"
        elif doc.ext == ".pptx":
            unit = " 张幻灯片"
        else:
            unit = " 页"
        parts.append(f"{doc.page_count}{unit}")
    parts.append(_human_size(doc.size_bytes))
    return " · ".join(parts)[:max_len]


def _human_size(size: int) -> str:
    value = float(size or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"
