"""知识库资产服务：登记本地文件、抽取 PDF 文本、转为可检索笔记。

设计边界：

- 本地文件仍是事实源：本服务只读取客户端上传的副本，从不写回本地目录；
- 保护目录（如 raw/、templates/）只登记不转换，避免 AI 产物污染原始资料；
- PDF 文本抽取失败不阻断登记（status=extract_failed），用户可以换用「转笔记」后手动补全。
"""
from __future__ import annotations

import hashlib
import io
import logging
import uuid
from pathlib import PurePosixPath

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kb import KbFile, KbRoot

logger = logging.getLogger(__name__)

MAX_PDF_PAGES = 200
MAX_EXTRACTED_CHARS = 200_000

_TEXT_SUFFIXES = {".txt", ".md", ".csv", ".log", ".json", ".yaml", ".yml"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _is_text_asset(mime: str | None, path: str) -> bool:
    if (mime or "").startswith("text/"):
        return True
    return PurePosixPath(path).suffix.lower() in _TEXT_SUFFIXES


def _is_image_asset(mime: str | None, path: str) -> bool:
    if (mime or "").startswith("image/"):
        return True
    return PurePosixPath(path).suffix.lower() in _IMAGE_SUFFIXES


def _extract_image_text(data: bytes) -> str:
    """OCR 图片文字；缺少 Pillow/tesseract 或识别失败时返回空字符串。"""
    try:
        import io as _io

        import pytesseract
        from PIL import Image

        image = Image.open(_io.BytesIO(data))
        text = pytesseract.image_to_string(image, lang="chi_sim+eng", timeout=60)
        return text.strip()[:MAX_EXTRACTED_CHARS]
    except Exception:  # noqa: BLE001 — OCR 是可选能力，失败不影响登记
        logger.warning("图片 OCR 失败或不可用", exc_info=True)
        return ""


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _extract_pdf_text(data: bytes) -> str:
    """抽取 PDF 文本层；扫描件（无文本层）返回空字符串。"""
    try:
        from pypdf import PdfReader
    except Exception:  # noqa: BLE001 — 依赖缺失时降级
        logger.warning("pypdf 未安装，跳过 PDF 文本抽取")
        return ""
    try:
        reader = PdfReader(io.BytesIO(data))
        parts: list[str] = []
        total = 0
        for page in reader.pages[:MAX_PDF_PAGES]:
            text = page.extract_text() or ""
            if not text.strip():
                continue
            parts.append(text.strip())
            total += len(text)
            if total >= MAX_EXTRACTED_CHARS:
                break
        return "\n\n".join(parts)[:MAX_EXTRACTED_CHARS]
    except Exception:  # noqa: BLE001 — 加密/损坏 PDF 不应让上传失败
        logger.warning("PDF 文本抽取失败", exc_info=True)
        return ""


class KbService:
    @staticmethod
    async def list_roots(db: AsyncSession, user_id: uuid.UUID) -> list[KbRoot]:
        result = await db.execute(
            select(KbRoot).where(KbRoot.user_id == user_id).order_by(KbRoot.created_at.desc()),
        )
        return list(result.scalars().all())

    @staticmethod
    async def get_root(
        db: AsyncSession, user_id: uuid.UUID, root_id: uuid.UUID,
    ) -> KbRoot | None:
        result = await db.execute(
            select(KbRoot).where(KbRoot.id == root_id, KbRoot.user_id == user_id),
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def ensure_root(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        name: str,
        folder_id: uuid.UUID | None = None,
    ) -> KbRoot:
        result = await db.execute(
            select(KbRoot).where(KbRoot.user_id == user_id, KbRoot.name == name),
        )
        root = result.scalar_one_or_none()
        if root is None:
            root = KbRoot(user_id=user_id, name=name[:200], folder_id=folder_id)
            db.add(root)
            await db.commit()
            await db.refresh(root)
        return root

    @staticmethod
    async def upload_file(
        db: AsyncSession,
        user_id: uuid.UUID,
        root: KbRoot,
        *,
        path: str,
        data: bytes,
        mime: str | None = None,
        is_protected: bool = False,
    ) -> KbFile:
        digest = sha256_bytes(data)
        result = await db.execute(
            select(KbFile).where(KbFile.root_id == root.id, KbFile.path == path),
        )
        record = result.scalar_one_or_none()
        if record is not None and record.content_hash == digest:
            record.size = len(data)
            record.is_protected = is_protected
            await db.commit()
            await db.refresh(record)
            return record

        is_pdf = (mime or "").lower() == "application/pdf" or path.lower().endswith(".pdf")
        if is_pdf:
            extracted = _extract_pdf_text(data)
            status = "extract_failed" if not extracted else "indexed"
        elif _is_text_asset(mime, path):
            extracted = data.decode("utf-8", errors="ignore")[:MAX_EXTRACTED_CHARS]
            status = "indexed"
        elif _is_image_asset(mime, path):
            extracted = _extract_image_text(data)
            status = "extract_failed" if not extracted else "indexed"
        else:
            extracted = None
            status = "indexed"

        if record is None:
            record = KbFile(
                root_id=root.id,
                user_id=user_id,
                path=path[:2000],
                mime=mime,
                size=len(data),
                content_hash=digest,
                extracted_text=extracted,
                status=status,
                is_protected=is_protected,
            )
            db.add(record)
        else:
            record.mime = mime
            record.size = len(data)
            record.content_hash = digest
            record.extracted_text = extracted
            record.status = status
            record.is_protected = is_protected
        await db.commit()
        await db.refresh(record)
        return record

    @staticmethod
    async def list_files(
        db: AsyncSession,
        user_id: uuid.UUID,
        *,
        query: str | None = None,
        limit: int = 50,
    ) -> list[KbFile]:
        stmt = select(KbFile).where(KbFile.user_id == user_id)
        if query:
            pattern = f"%{query.strip()}%"
            stmt = stmt.where(
                KbFile.path.ilike(pattern) | KbFile.extracted_text.ilike(pattern),
            )
        stmt = stmt.order_by(KbFile.updated_at.desc()).limit(limit)
        result = await db.execute(stmt)
        return list(result.scalars().all())

    @staticmethod
    async def get_file(
        db: AsyncSession, user_id: uuid.UUID, file_id: uuid.UUID,
    ) -> KbFile | None:
        result = await db.execute(
            select(KbFile).where(KbFile.id == file_id, KbFile.user_id == user_id),
        )
        return result.scalar_one_or_none()

    @staticmethod
    async def sync_manifest(
        db: AsyncSession,
        user_id: uuid.UUID,
        root: KbRoot,
        files: list[dict],
    ) -> dict:
        """清单协商：返回需要上传/已移除的文件，避免整目录重复上传。

        ``files`` 每项: ``{"path": str, "hash": str, "size": int?, "mime": str?}``。
        已登记且 hash 一致的文件只刷新元数据；客户端缺失的文件标记为 missing。
        """
        result = await db.execute(
            select(KbFile).where(KbFile.root_id == root.id),
        )
        existing = {record.path: record for record in result.scalars().all()}
        manifest_paths: set[str] = set()
        to_upload: list[str] = []
        unchanged = 0
        missing: list[str] = []

        for item in files:
            path = str(item.get("path") or "").strip()
            digest = str(item.get("hash") or "").strip()
            if not path or not digest:
                continue
            manifest_paths.add(path)
            record = existing.get(path)
            if record is not None and record.content_hash == digest:
                record.size = int(item.get("size") or record.size)
                if item.get("mime"):
                    record.mime = str(item.get("mime"))[:120]
                unchanged += 1
                continue
            to_upload.append(path)

        for path, record in existing.items():
            if path not in manifest_paths and record.status != "missing":
                record.status = "missing"
                missing.append(path)

        await db.commit()
        return {
            "toUpload": to_upload,
            "unchanged": unchanged,
            "missing": missing,
            "total": len(manifest_paths),
        }

    @staticmethod
    async def to_note(db: AsyncSession, user_id: uuid.UUID, record: KbFile):
        """把资产内容转成 Markdown 笔记（PDF 文本/路径），之后自动进入 RAG 索引。"""
        from app.services.note.note_service import NoteService

        title = PurePosixPath(record.path).stem[:100] or "知识库文件"
        body_parts = [
            f"> 来源：`{record.path}`",
            "",
        ]
        if record.extracted_text:
            body_parts.append(record.extracted_text)
        else:
            body_parts.append("（该文件暂无可提取文本；请打开原文件补充内容或稍后重试）")
        note = await NoteService.create_note(db, {
            "title": title,
            "note_type": "markdown",
            "content": {"text": "\n".join(body_parts)},
            "created_by": user_id,
            "updated_by": user_id,
        })
        record.note_id = note.id
        record.status = "converted"
        await db.commit()
        return note
