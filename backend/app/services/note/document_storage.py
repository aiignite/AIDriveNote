"""文档原文件存储：内容寻址落盘、魔数嗅探、路径安全与引用计数删除。

与 ``note_asset_service`` 的区别：
- 文档按全局 SHA-256 去重，但**不提供公共读取**，只能经带鉴权的笔记接口访问；
- 写入前做魔数 / ZIP 结构校验，拒绝"改扩展名"的可执行内容；
- 删除时同时检查笔记、KB 资产、知识入库三处引用。
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.exceptions import BadRequestException

logger = logging.getLogger(__name__)

# ext → (mime, 是否可在前端预览)
ALLOWED_DOCUMENTS: dict[str, tuple[str, bool]] = {
    ".pdf": ("application/pdf", True),
    ".docx": (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        True,
    ),
    ".xlsx": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        True,
    ),
    ".pptx": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        True,
    ),
    ".html": ("text/html", True),
    ".htm": ("text/html", True),
    ".doc": ("application/msword", False),
    ".xls": ("application/vnd.ms-excel", False),
    ".ppt": ("application/vnd.ms-powerpoint", False),
}

_STORAGE_RE = re.compile(
    r"^documents/[0-9a-f]{2}/[0-9a-f]{64}\.(?:pdf|docx|xlsx|pptx|html|htm|doc|xls|ppt)$",
)
_ZIP_MAGIC = b"PK\x03\x04"
_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
_ZIP_DOC_MARKERS = {
    "word/document.xml": ".docx",
    "xl/workbook.xml": ".xlsx",
    "ppt/presentation.xml": ".pptx",
}

MAX_ZIP_ENTRIES = 2000
MAX_ZIP_TOTAL_BYTES = 300 * 1024 * 1024
MAX_ZIP_ENTRY_BYTES = 100 * 1024 * 1024
MAX_ZIP_RATIO = 200


@dataclass(frozen=True)
class SniffResult:
    ext: str
    mime: str
    viewable: bool


@dataclass(frozen=True)
class StoredDocument:
    sha256: str
    ext: str
    mime: str
    size_bytes: int
    storage_path: str
    viewable: bool


def max_document_bytes() -> int:
    return get_settings().USER_MAX_DOCUMENT_BYTES


def _root() -> Path:
    backend_root = Path(__file__).resolve().parents[3]
    return backend_root / "uploads"


def _resolve(storage_path: str) -> Path:
    """把 ``documents/xx/<sha>.ext`` 解析为绝对路径，阻断路径穿越。"""
    if not _STORAGE_RE.fullmatch(storage_path or ""):
        raise BadRequestException("非法的文档路径")
    root = _root().resolve()
    candidate = (root / storage_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise BadRequestException("非法的文档路径")
    return candidate


def resolve_path(storage_path: str) -> Path | None:
    try:
        path = _resolve(storage_path)
    except BadRequestException:
        return None
    return path if path.is_file() else None


def safe_file_name(name: str) -> str:
    base = Path(name or "document").name
    base = "".join(ch for ch in base if ch.isprintable() and ch not in "\r\n\t").strip()
    return (base or "document")[:200]


def _validate_zip(data: bytes, ext: str) -> None:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise BadRequestException("文件不是有效的 Office 文档") from exc

    infos = archive.infolist()
    if len(infos) > MAX_ZIP_ENTRIES:
        raise BadRequestException("Office 文档内部条目过多，已拒绝解析")

    total = 0
    marker_ext = ""
    for info in infos:
        if info.file_size > MAX_ZIP_ENTRY_BYTES:
            raise BadRequestException("Office 文档包含过大的内部文件")
        total += info.file_size
        if total > MAX_ZIP_TOTAL_BYTES:
            raise BadRequestException("Office 文档解压后体积过大")
        if info.compress_size > 0 and info.file_size / info.compress_size > MAX_ZIP_RATIO:
            raise BadRequestException("Office 文档压缩比异常，可能是压缩炸弹")
        if info.filename in _ZIP_DOC_MARKERS:
            marker_ext = _ZIP_DOC_MARKERS[info.filename]

    if marker_ext != ext:
        raise BadRequestException("文件内容与扩展名不符")


def sniff_and_validate(data: bytes, filename: str) -> SniffResult:
    """按扩展名白名单 + 魔数校验文件，返回服务端认定的类型。"""
    if not data:
        raise BadRequestException("文件内容为空")

    ext = Path(filename or "").suffix.lower()
    allowed = ALLOWED_DOCUMENTS.get(ext)
    if allowed is None:
        raise BadRequestException(f"不支持的文档类型：{ext or '未知'}")

    mime, viewable = allowed
    size = len(data)
    if size > max_document_bytes():
        limit_mb = max_document_bytes() / 1024 / 1024
        raise BadRequestException(
            f"文件过大（{size / 1024 / 1024:.1f}MB > {limit_mb:.0f}MB）",
        )

    if ext == ".pdf":
        if not data.startswith(b"%PDF-"):
            raise BadRequestException("文件不是有效的 PDF")
    elif ext in {".docx", ".xlsx", ".pptx"}:
        if not data.startswith(_ZIP_MAGIC):
            raise BadRequestException("文件不是有效的 Office 文档")
        _validate_zip(data, ext)
    elif ext in {".doc", ".xls", ".ppt"}:
        if not data.startswith(_OLE2_MAGIC):
            raise BadRequestException("文件不是有效的旧版 Office 文档")
    elif ext in {".html", ".htm"}:
        from app.services.knowledge.parsing.base import decode_bytes

        text, _ = decode_bytes(data)
        sample = text[:4000]
        printable = sum(1 for ch in sample if ch.isprintable() or ch in "\n\t\r")
        if not sample.strip() or printable / len(sample) < 0.85:
            raise BadRequestException("文件不是有效的 HTML")

    return SniffResult(ext=ext, mime=mime, viewable=viewable)


def store(data: bytes, filename: str) -> StoredDocument:
    """校验并落盘；同内容直接复用已有文件。"""
    sniffed = sniff_and_validate(data, filename)
    digest = hashlib.sha256(data).hexdigest()
    storage_path = f"documents/{digest[:2]}/{digest}{sniffed.ext}"
    target = _resolve(storage_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{sniffed.ext}.", suffix=".tmp", dir=str(target.parent),
        )
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.replace(tmp_name, target)
        finally:
            if os.path.exists(tmp_name):
                os.unlink(tmp_name)
    return StoredDocument(
        sha256=digest,
        ext=sniffed.ext,
        mime=sniffed.mime,
        size_bytes=len(data),
        storage_path=storage_path,
        viewable=sniffed.viewable,
    )


def describe_stored(storage_path: str, filename: str, size_bytes: int) -> StoredDocument:
    """历史 KB / ingest 行已有 ``storage_path`` 时，补出元数据而不重新落盘。"""
    ext = Path(filename or "").suffix.lower() or Path(storage_path).suffix.lower()
    allowed = ALLOWED_DOCUMENTS.get(ext)
    if allowed is None:
        raise BadRequestException(f"不支持的文档类型：{ext or '未知'}")
    match = re.search(r"([0-9a-f]{64})", storage_path)
    return StoredDocument(
        sha256=match.group(1) if match else "",
        ext=ext,
        mime=allowed[0],
        size_bytes=size_bytes,
        storage_path=storage_path,
        viewable=allowed[1],
    )


async def delete_if_unreferenced(db: AsyncSession, sha256: str, ext: str) -> bool:
    """三个引用点都归零后删除磁盘文件；返回是否真的删除。"""
    from app.models.kb import KbFile
    from app.models.knowledge import IngestDocument
    from app.models.note.document import NoteDocument

    if not re.fullmatch(r"[0-9a-f]{64}", sha256 or ""):
        raise BadRequestException("非法的文档哈希")

    pattern = f"%/{sha256}.%"
    note_refs = (
        await db.execute(
            select(func.count()).select_from(NoteDocument).where(NoteDocument.sha256 == sha256),
        )
    ).scalar() or 0
    kb_refs = (
        await db.execute(
            select(func.count()).select_from(KbFile).where(KbFile.storage_path.like(pattern)),
        )
    ).scalar() or 0
    ingest_refs = (
        await db.execute(
            select(func.count()).select_from(IngestDocument).where(
                IngestDocument.storage_path.like(pattern),
            ),
        )
    ).scalar() or 0
    if note_refs or kb_refs or ingest_refs:
        return False

    try:
        target = _resolve(f"documents/{sha256[:2]}/{sha256}{ext}")
    except BadRequestException:
        return False
    if not target.exists():
        return False
    target.unlink()
    return True
