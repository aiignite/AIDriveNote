"""知识库资产服务：登记本地文件、抽取 PDF 文本、转为可检索笔记。

设计边界：

- 本地文件仍是事实源：本服务只读取客户端上传的副本，从不写回本地目录；
- 保护目录（如 raw/、templates/）只登记不转换，避免 AI 产物污染原始资料；
- PDF 文本抽取失败不阻断登记（status=extract_failed），用户可以换用「转笔记」后手动补全。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from pathlib import PurePosixPath

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BadRequestException
from app.models.kb import KbFile, KbRoot
from app.models.note.note import NoteFolder
from app.services.note import document_storage

logger = logging.getLogger(__name__)

# 知识库在笔记树中的固定根文件夹名（根级、系统保护）
KNOWLEDGE_FOLDER_NAME = "知识库"

MAX_EXTRACTED_CHARS = 200_000

_TEXT_SUFFIXES = {".txt", ".md", ".csv", ".log", ".json", ".yaml", ".yml"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
_PARSE_SUFFIXES = {".pdf", ".docx", ".xlsx", ".pptx", ".html", ".htm"}


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


async def _extract_document_text(data: bytes, path: str, mime: str | None) -> str:
    """复用知识入库解析器抽取文档正文；失败返回空串。"""
    from app.services.note.document_service import parse_document_bytes

    try:
        parsed = await parse_document_bytes(data, PurePosixPath(path).name, mime or "")
        return (parsed.text or "")[:MAX_EXTRACTED_CHARS]
    except Exception:  # noqa: BLE001 — 抽取失败不阻断资产登记
        logger.warning("KB 文档文本抽取失败: %s", path, exc_info=True)
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
    async def ensure_knowledge_root(
        db: AsyncSession, user_id: uuid.UUID,
    ) -> tuple[KbRoot, NoteFolder]:
        """确保用户存在唯一的「知识库」根文件夹，并把 KbRoot 绑定到它。

        - 文件夹固定建在笔记树根级，并标记 is_system（删除 / 移动会被路由层拒绝）；
        - 已有关联文件夹时只补标记，不搬动用户现有结构；
        - 关联文件夹失效（被删或不属于本人）时重新找一个根级同名文件夹或新建。
        """
        result = await db.execute(
            select(KbRoot)
            .where(KbRoot.user_id == user_id)
            .order_by(KbRoot.created_at.asc()),
        )
        roots = list(result.scalars().all())

        folder: NoteFolder | None = None
        root: KbRoot | None = None
        # 优先沿用已绑定且仍然有效的根
        for candidate_root in roots:
            if candidate_root.folder_id is None:
                continue
            candidate = await db.get(NoteFolder, candidate_root.folder_id)
            if (
                candidate is not None
                and not candidate.is_deleted
                and candidate.user_id == user_id
            ):
                root = candidate_root
                folder = candidate
                if not folder.is_system:
                    folder.is_system = True
                break
        if root is None:
            root = roots[0] if roots else None

        if folder is None:
            result = await db.execute(
                select(NoteFolder).where(
                    NoteFolder.user_id == user_id,
                    NoteFolder.parent_id.is_(None),
                    NoteFolder.is_deleted == False,  # noqa: E712
                    NoteFolder.name == KNOWLEDGE_FOLDER_NAME,
                ),
            )
            folder = result.scalars().first()
            if folder is None:
                folder = NoteFolder(
                    name=KNOWLEDGE_FOLDER_NAME,
                    parent_id=None,
                    user_id=user_id,
                    is_system=True,
                )
                db.add(folder)
                await db.flush()
            else:
                folder.is_system = True

        if root is None:
            root = KbRoot(user_id=user_id, name=KNOWLEDGE_FOLDER_NAME)
            db.add(root)
        root.folder_id = folder.id

        await db.commit()
        await db.refresh(root)
        await db.refresh(folder)
        return root, folder

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
        storage_path: str | None = None
        try:
            stored = await asyncio.to_thread(document_storage.store, data, PurePosixPath(path).name)
            storage_path = stored.storage_path
            mime = stored.mime
        except BadRequestException:
            # 非白名单 / 超过文档上限：沿用旧的"只登记 + 抽取文本"路径
            pass

        result = await db.execute(
            select(KbFile).where(KbFile.root_id == root.id, KbFile.path == path),
        )
        record = result.scalar_one_or_none()
        if record is not None and record.content_hash == digest:
            record.size = len(data)
            record.is_protected = is_protected
            # 历史行没有原文件：本次上传补齐，之后才能在线预览
            if storage_path and not record.storage_path:
                record.storage_path = storage_path
                record.mime = mime
            await db.commit()
            await db.refresh(record)
            return record

        suffix = PurePosixPath(path).suffix.lower()
        extracted: str | None = None
        if suffix in _PARSE_SUFFIXES:
            extracted = await _extract_document_text(data, path, mime)
            status = "indexed" if extracted else "extract_failed"
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
                storage_path=storage_path,
                extracted_text=extracted,
                status=status,
                is_protected=is_protected,
            )
            db.add(record)
        else:
            record.mime = mime
            record.size = len(data)
            record.content_hash = digest
            record.storage_path = storage_path or record.storage_path
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
        """把资产转成笔记：可预览文档生成文档笔记，其余沿用 Markdown。"""
        from app.services.note.document_service import create_document_note_from_stored
        from app.services.note.note_service import NoteService

        if record.note_id:
            existing = await NoteService.get_note(db, record.note_id)
            if existing is not None:
                return existing

        title = PurePosixPath(record.path).stem[:100] or "知识库文件"
        root = await db.get(KbRoot, record.root_id)
        if record.storage_path:
            try:
                stored = document_storage.describe_stored(
                    record.storage_path, PurePosixPath(record.path).name, record.size,
                )
                note, _document = await create_document_note_from_stored(
                    db,
                    user_id,
                    stored=stored,
                    filename=PurePosixPath(record.path).name,
                    folder_id=root.folder_id if root else None,
                    title=title,
                    description=f"知识库：{record.path}",
                    parsed_text=record.extracted_text or "",
                    parsed_meta={},
                    parser=None,
                )
                record.note_id = note.id
                record.status = "converted"
                await db.commit()
                return note
            except BadRequestException:
                logger.warning("KB 文档转笔记失败，回退 Markdown: %s", record.path)

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
