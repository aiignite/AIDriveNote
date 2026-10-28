"""Note Management router – 笔记管理 API."""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, get_args
from uuid import UUID

from pydantic import BaseModel
from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.config import get_settings
from app.database import get_db
from app.auth import get_current_user, require_not_guest, require_write_scope
from app.models.user import User
from app.models.note.document import NoteDocument
from app.models.note.note import Note, NoteFolder
from app.services.auth_service import AuthService
from app.services.note import document_service, document_storage
from app.services.note.note_service import NoteService, NoteFolderService, NoteTemplateService
from app.services.note import note_crypto
from app.services.note.note_lock_service import NoteLockService
from app.services.note.note_asset_service import MAX_IMAGE_BYTES, NoteAssetService, read_asset
from app.services.note.note_enhance_service import (
    NoteFavoriteService,
    NoteLinkService,
    NoteRevisionService,
    NoteShareService,
    NoteSearchService,
    NoteTagService,
    highlight_snippet,
    note_preview_text,
)
from app.services.note.link_parser import build_search_text
from app.exceptions import BadRequestException, ConflictException, ForbiddenException, NotFoundException

router = APIRouter(prefix="/notes", tags=["Notes"])

# 笔记类型的唯一合法取值；与数据库 CHECK 约束 ck_note_notes_note_type 保持一致。
NoteType = Literal["rich_text", "markdown", "mindmap", "flowchart", "document"]
NOTE_TYPES: tuple[str, ...] = get_args(NoteType)


def _assert_note_owner(note: Note, user: User) -> None:
    if note.created_by and note.created_by != user.id:
        raise ForbiddenException("Note")


async def _assert_note_access(db: AsyncSession, note: Note, user: User) -> None:
    if note.created_by and note.created_by != user.id:
        if not await NoteShareService.user_can_access(db, note, user.id):
            raise ForbiddenException("Note")


async def _assert_note_edit(db: AsyncSession, note: Note, user: User) -> None:
    if note.created_by and note.created_by != user.id:
        if not await NoteShareService.user_can_edit(db, note, user.id):
            raise ForbiddenException("Note")


def _assert_folder_owner(folder: NoteFolder, user: User) -> None:
    if folder.user_id != user.id:
        raise ForbiddenException("Folder")


def _assert_folder_mutable(folder: NoteFolder) -> None:
    """系统文件夹（知识库根）承担固定映射职责，禁止删除、移动与加密。"""
    if folder.is_system:
        raise BadRequestException("系统文件夹受保护，不能删除、移动或加密")


# ── Note Schemas ──

class NoteCreate(BaseModel):
    title: str
    note_type: NoteType
    content: Optional[dict] = None
    folder_id: Optional[UUID] = None
    description: Optional[str] = None
    status: Optional[str] = "Active"


class NoteAppend(BaseModel):
    """追加内容请求体。"""

    # 待追加的内容，Markdown 或纯文本
    text: str
    # 预留的追加模式位，当前仅支持 text
    mode: str = "text"


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    note_type: Optional[NoteType] = None
    content: Optional[dict] = None
    folder_id: Optional[UUID] = None
    description: Optional[str] = None
    status: Optional[str] = None
    is_pinned: Optional[bool] = None


class PasswordBody(BaseModel):
    """加解密 / 解锁请求体（笔记与文件夹共用）。"""

    password: str


class ChangePasswordBody(BaseModel):
    """修改笔记密码请求体。"""

    old_password: str
    new_password: str


class NoteLockOut(BaseModel):
    """笔记加解密 / 解锁响应：携带更新后的笔记与（可选）解锁票据。"""

    note: "NoteOut"
    unlock_token: Optional[str] = None


class FolderLockOut(BaseModel):
    """文件夹加解密 / 解锁响应。"""

    folder: "FolderOut"
    unlock_token: Optional[str] = None
    # 涉及的笔记数量（加密 / 解密时有效）
    affected: int = 0


class DocumentOut(BaseModel):
    file_name: str
    mime: str
    ext: str
    size_bytes: int
    page_count: Optional[int] = None
    etag: str
    viewable: bool = True
    extract_status: str = "pending"


class NoteOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    note_no: str
    title: str
    note_type: str
    content: Optional[dict] = None
    document: Optional[DocumentOut] = None
    folder_id: Optional[UUID] = None
    description: Optional[str] = None
    status: str
    is_pinned: bool = False
    is_deleted: bool
    deleted_at: Optional[datetime] = None
    # 笔记自身是否启用加密
    is_encrypted: bool = False
    # 当前请求是否处于锁定态（自身加密或受加密文件夹保护且未解锁）
    is_locked: bool = False
    # 锁定的来源：note（笔记自身）/ folder（加密文件夹）
    locked_scope: Optional[str] = None
    # 锁定对象 ID（笔记自身为 note_id，文件夹为 folder_id）
    locked_id: Optional[UUID] = None
    created_by: Optional[UUID] = None
    updated_by: Optional[UUID] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    preview_text: Optional[str] = None
    is_favorite: bool = False
    # RAG 索引状态：pending / ok / failed / skipped；None 表示尚未建文档记录
    index_status: Optional[str] = None
    tags: list["TagOut"] = []


class TagOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    name: str
    color: str


class TagCreate(BaseModel):
    name: str
    color: Optional[str] = "#6b7280"


class TagUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None


class RevisionOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    note_id: UUID
    title: str
    content_snapshot: Optional[dict] = None
    description: Optional[str] = None
    change_summary: Optional[str] = None
    changed_by: Optional[UUID] = None
    created_at: Optional[datetime] = None


class ShareOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    note_id: UUID
    shared_with_user_id: UUID
    permission: str
    created_by: Optional[UUID] = None
    created_at: Optional[datetime] = None


class ShareCreate(BaseModel):
    shared_with_user_id: UUID
    permission: str = "view"


class BacklinkOut(BaseModel):
    link_id: str
    source_id: str
    source_title: str
    source_note_no: str
    link_text: str


class SearchKnowledgeOut(BaseModel):
    summary: Optional[str] = None
    keywords: list[str] = []
    source_type: Optional[str] = None
    knowledge_type: Optional[str] = None
    confidence: Optional[str] = None


class SearchResultOut(BaseModel):
    items: list[NoteOut]
    total: int
    highlights: dict[str, str] = {}
    knowledge: dict[str, SearchKnowledgeOut] = {}


class RelatedNoteOut(BaseModel):
    id: str
    noteNo: Optional[str] = None
    title: str
    noteType: str
    snippet: str = ""
    score: float = 0.0
    linked: bool = False


class TagSuggestionOut(BaseModel):
    name: str
    color: Optional[str] = None
    existing: bool = False
    score: float = 0.0


class PublicLinkOut(BaseModel):
    token: str
    expiresAt: Optional[str] = None


class RagChunkOut(BaseModel):
    chunkId: str
    noteId: str
    headingPath: Optional[str] = None
    content: str
    title: str


# 哨兵：区分「未传入 lock」与「显式传入 None（已解锁）」
_UNSET = object()
_DOC_UNSET = object()


async def _load_folder_maps(db: AsyncSession, user_id: UUID) -> tuple[dict, set]:
    """一次性加载用户的文件夹父子关系与加密文件夹集合，供批量脱敏使用。"""
    rows = (
        await db.execute(
            select(NoteFolder.id, NoteFolder.parent_id, NoteFolder.is_encrypted).where(
                NoteFolder.user_id == user_id,
                NoteFolder.is_deleted == False,  # noqa: E712
            )
        )
    ).all()
    parent_map = {r[0]: r[1] for r in rows}
    enc_ids = {r[0] for r in rows if r[2]}
    return parent_map, enc_ids


def _resolve_lock_fast(note: Note, parent_map: dict, enc_ids: set) -> tuple[str, UUID] | None:
    """基于预加载的文件夹映射廉价解析锁定对象（避免逐条查库）。"""
    if note.is_encrypted:
        return ("note", note.id)
    fid = note.folder_id
    seen: set = set()
    while fid and fid not in seen:
        seen.add(fid)
        if fid in enc_ids:
            return ("folder", fid)
        fid = parent_map.get(fid)
    return None


async def _enrich_note_out(
    db: AsyncSession,
    note: Note,
    user: User,
    *,
    tags: list | None = None,
    is_favorite: bool | None = None,
    include_content: bool = True,
    lock: object = _UNSET,
    is_locked: bool | None = None,
    index_status: str | None = None,
    document: NoteDocument | None | object = _DOC_UNSET,
) -> NoteOut:
    # 多次 commit / 原生 SQL 更新后，server_default 列可能已过期；异步会话不能在
    # 同步属性访问时隐式补查，这里显式刷新一次。
    from sqlalchemy import inspect as sa_inspect

    if sa_inspect(note).expired_attributes:
        await db.refresh(note)
    if tags is None:
        tags = await NoteTagService.get_note_tags(db, note.id)
    if is_favorite is None:
        is_favorite = await NoteFavoriteService.is_favorited(db, user.id, note.id)
    if lock is _UNSET:
        lock = await NoteLockService.resolve_lock(db, note)
    if document is _DOC_UNSET:
        document = (
            await document_service.get_document(db, note.id)
            if note.note_type == "document" else None
        )
    locked = is_locked if is_locked is not None else lock is not None
    # 锁定态一律不返回正文、文档元数据与预览，避免密文/明文外泄
    content = None if locked else (note.content if include_content else None)
    doc_meta = None
    if not locked and document is not None:
        doc_meta = DocumentOut(**document_service.build_document_meta(document))
    if locked:
        preview_text = None
    elif document is not None:
        preview_text = note.description or document_service.preview_text(document)
    else:
        preview_text = note_preview_text(note)
    return NoteOut(
        id=note.id,
        note_no=note.note_no,
        title=note.title,
        note_type=note.note_type,
        content=content,
        document=doc_meta,
        folder_id=note.folder_id,
        description=note.description,
        status=note.status,
        is_pinned=note.is_pinned,
        is_deleted=note.is_deleted,
        deleted_at=note.deleted_at,
        is_encrypted=note.is_encrypted,
        is_locked=locked,
        locked_scope=lock[0] if lock else None,  # type: ignore[index]
        locked_id=lock[1] if lock else None,  # type: ignore[index]
        created_by=note.created_by,
        updated_by=note.updated_by,
        created_at=note.created_at,
        updated_at=note.updated_at,
        preview_text=preview_text,
        is_favorite=is_favorite,
        index_status=index_status,
        tags=[TagOut.model_validate(t) for t in tags],
    )


async def _load_index_status_map(
    db: AsyncSession, note_ids: list[UUID],
) -> dict[str, str]:
    """批量读取 RAG 文档状态；非 PG / 未启用 / 未装 pgvector 时返回空。"""
    if not note_ids or not get_settings().RAG_V2_ENABLED:
        return {}
    try:
        if db.get_bind().dialect.name != "postgresql":
            return {}
        from app.services.ai.rag_v2_schema import rag_v2_available

        if not await rag_v2_available(db):
            return {}
        params = {f"id{index}": str(note_id) for index, note_id in enumerate(note_ids)}
        placeholders = ", ".join(f":{key}" for key in params)
        result = await db.execute(
            text(f"SELECT note_id, status FROM rag_documents WHERE note_id IN ({placeholders})"),
            params,
        )
        return {str(row[0]): str(row[1]) for row in result.fetchall()}
    except Exception:  # noqa: BLE001 — 状态展示不能影响列表接口
        logger.warning("读取 RAG 索引状态失败", exc_info=True)
        return {}


async def _enrich_notes_batch(
    db: AsyncSession, notes: list[Note], user: User, *, include_content: bool = True,
) -> list[NoteOut]:
    if not notes:
        return []
    note_ids = [n.id for n in notes]
    tags_map = await NoteTagService.get_tags_for_notes(db, note_ids)
    fav_ids = await NoteFavoriteService.get_favorited_note_ids(db, user.id, note_ids)
    parent_map, enc_ids = await _load_folder_maps(db, user.id)
    index_map = await _load_index_status_map(db, note_ids)
    doc_map = await document_service.get_document_meta_map(db, note_ids)
    return [
        await _enrich_note_out(
            db, note, user,
            tags=tags_map.get(note.id, []),
            is_favorite=note.id in fav_ids,
            include_content=include_content,
            lock=_resolve_lock_fast(note, parent_map, enc_ids),
            index_status=index_map.get(str(note.id)),
            document=doc_map.get(str(note.id)),
        )
        for note in notes
    ]


class NoteListOut(BaseModel):
    items: list[NoteOut]
    total: int


# ── Folder Schemas ──

class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[UUID] = None


class FolderUpdate(BaseModel):
    name: Optional[str] = None
    parent_id: Optional[UUID] = None
    sort_order: Optional[int] = None


class FolderOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    name: str
    parent_id: Optional[UUID] = None
    user_id: UUID
    sort_order: int
    # 系统文件夹（如知识库根）不可删除 / 移动
    is_system: bool = False
    # 文件夹是否启用加密
    is_encrypted: bool = False
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class TemplateCreate(BaseModel):
    name: str
    note_type: str
    description: Optional[str] = None
    content: Optional[dict] = None
    thumbnail: Optional[str] = None
    sort_order: int = 0


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    note_type: Optional[str] = None
    description: Optional[str] = None
    content: Optional[dict] = None
    thumbnail: Optional[str] = None
    sort_order: Optional[int] = None


class TemplateOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    name: str
    note_type: str
    description: Optional[str] = None
    content: Optional[dict] = None
    thumbnail: Optional[str] = None
    is_builtin: bool = False
    sort_order: int = 0
    user_id: Optional[UUID] = None
    created_by: Optional[UUID] = None
    updated_by: Optional[UUID] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class CreateFromTemplateBody(BaseModel):
    template_id: UUID
    title: Optional[str] = None
    folder_id: Optional[UUID] = None


# ── Note Endpoints ──

@router.get("", response_model=NoteListOut)
async def list_notes(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    search: Optional[str] = None,
    note_type: Optional[str] = None,
    folder_id: Optional[str] = None,
    status: Optional[str] = None,
    is_pinned: Optional[bool] = None,
    is_favorite: Optional[bool] = None,
    tag_ids: Optional[str] = None,
    include_shared: bool = False,
    include_content: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    parsed_tag_ids = [UUID(t) for t in tag_ids.split(",")] if tag_ids else None
    items, total = await NoteService.list_notes(
        db,
        skip=skip,
        limit=limit,
        search=search,
        note_type=note_type,
        folder_id=UUID(folder_id) if folder_id else None,
        user_id=user.id,
        status=status,
        is_pinned=is_pinned,
        is_favorite=is_favorite,
        tag_ids=parsed_tag_ids,
        include_shared=include_shared,
    )
    enriched = await _enrich_notes_batch(db, items, user, include_content=include_content)
    return NoteListOut(items=enriched, total=total)


@router.get("/trash/list", response_model=NoteListOut)
async def list_trash_notes(
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    search: Optional[str] = None,
    include_content: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    items, total = await NoteService.list_trash_notes(
        db,
        user_id=user.id,
        skip=skip,
        limit=limit,
        search=search,
    )
    enriched = await _enrich_notes_batch(db, items, user, include_content=include_content)
    return NoteListOut(items=enriched, total=total)


async def _knowledge_search_meta(
    db: AsyncSession, note_ids: list[UUID],
) -> dict[str, SearchKnowledgeOut]:
    """给搜索结果补充知识卡摘要/关键词/来源；每篇笔记只取最新一张已批准卡。"""
    if not note_ids:
        return {}
    from app.models.knowledge import IngestDocument, KnowledgeCard

    rows = await db.execute(
        select(KnowledgeCard, IngestDocument)
        .join(IngestDocument, IngestDocument.id == KnowledgeCard.document_id)
        .where(
            KnowledgeCard.note_id.in_(note_ids),
            KnowledgeCard.status.in_(["approved", "merged"]),
        )
        .order_by(KnowledgeCard.decided_at.desc())
    )
    result: dict[str, SearchKnowledgeOut] = {}
    for card, doc in rows.all():
        key = str(card.note_id)
        if key in result:
            continue
        payload = card.payload or {}
        result[key] = SearchKnowledgeOut(
            summary=(card.summary or "")[:300] or None,
            keywords=[str(item) for item in payload.get("keywords") or []][:8],
            source_type=doc.source_type,
            knowledge_type=card.knowledge_type,
            confidence=card.confidence,
        )
    return result


@router.get("/search/fulltext", response_model=SearchResultOut)
async def search_notes_fulltext(
    q: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    include_content: bool = False,
    include_shared: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    items, total = await NoteSearchService.full_text_search(
        db, user_id=user.id, query=q, skip=skip, limit=limit,
        include_shared=include_shared,
    )
    enriched = await _enrich_notes_batch(db, items, user, include_content=include_content)
    highlights = {
        str(n.id): highlight_snippet(
            n.search_text or build_search_text(n.title, n.description, n.content, n.note_type),
            q,
            max_len=200,
        )
        for n in items
    }
    knowledge = await _knowledge_search_meta(db, [n.id for n in items])
    return SearchResultOut(
        items=enriched, total=total, highlights=highlights, knowledge=knowledge,
    )


@router.get("/tags/list", response_model=list[TagOut])
async def list_tags(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await NoteTagService.list_tags(db, user.id)


@router.post("/tags", response_model=TagOut, status_code=status.HTTP_201_CREATED)
async def create_tag(
    body: TagCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await NoteTagService.create_tag(db, user.id, body.name, body.color or "#6b7280")


@router.patch("/tags/{tag_id}", response_model=TagOut)
async def update_tag(
    tag_id: UUID,
    body: TagUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = await NoteTagService.update_tag(db, tag_id, user.id, body.model_dump(exclude_unset=True))
    if not item:
        raise NotFoundException("Tag")
    return item


@router.delete("/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(
    tag_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ok = await NoteTagService.delete_tag(db, tag_id, user.id)
    if not ok:
        raise NotFoundException("Tag")


@router.get("/folders/list", response_model=list[FolderOut])
async def list_folders(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await NoteFolderService.list_folders(db, user.id)


@router.post("/folders", response_model=FolderOut, status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: FolderCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = body.model_dump()
    data["user_id"] = user.id
    return await NoteFolderService.create_folder(db, data)


@router.patch("/folders/{folder_id}", response_model=FolderOut)
async def update_folder(
    folder_id: UUID,
    body: FolderUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    folder = await NoteFolderService.get_folder(db, folder_id)
    if not folder:
        raise NotFoundException("Folder")
    _assert_folder_owner(folder, user)
    payload = body.model_dump(exclude_unset=True)
    if folder.is_system and "parent_id" in payload and payload["parent_id"] != folder.parent_id:
        _assert_folder_mutable(folder)
    item = await NoteFolderService.update_folder(db, folder_id, payload)
    if not item:
        raise NotFoundException("Folder")
    return item


@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    folder = await NoteFolderService.get_folder(db, folder_id)
    if not folder:
        raise NotFoundException("Folder")
    _assert_folder_owner(folder, user)
    _assert_folder_mutable(folder)
    # 删除父目录会级联软删除子孙：若子树里含系统文件夹，同样必须拒绝
    descendant_ids = await NoteFolderService._collect_descendant_folder_ids(db, folder_id)
    if descendant_ids:
        protected = await db.execute(
            select(NoteFolder.id).where(
                NoteFolder.id.in_(descendant_ids),
                NoteFolder.is_system == True,  # noqa: E712
            ),
        )
        if protected.first() is not None:
            raise BadRequestException("文件夹内包含受保护的系统文件夹，不能删除")
    ok = await NoteFolderService.delete_folder(db, folder_id)
    if not ok:
        raise NotFoundException("Folder")


# ── 加密 / 解密 / 解锁（文件夹） ──

@router.post("/folders/{folder_id}/encrypt", response_model=FolderLockOut)
async def encrypt_folder(
    folder_id: UUID,
    body: PasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """加密文件夹：为子树内笔记用同一密钥重新加密正文。"""
    folder = await NoteFolderService.get_folder(db, folder_id)
    if not folder:
        raise NotFoundException("Folder")
    _assert_folder_owner(folder, user)
    _assert_folder_mutable(folder)
    if folder.is_encrypted:
        raise BadRequestException("文件夹已加密")
    if await NoteLockService.folder_is_locked(db, folder.parent_id):
        raise BadRequestException("父文件夹已加密，无需重复加密")
    password = body.password.strip()
    if len(password) < 4:
        raise BadRequestException("密码至少 4 位")
    key, affected = await NoteLockService.encrypt_folder(db, folder, password)
    token = note_crypto.make_unlock_token(
        scope="folder", target_id=folder.id, user_id=user.id, key_b64=key,
    )
    return FolderLockOut(
        folder=FolderOut.model_validate(folder), unlock_token=token, affected=affected,
    )


@router.post("/folders/{folder_id}/unlock", response_model=FolderLockOut)
async def unlock_folder(
    folder_id: UUID,
    body: PasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """校验文件夹密码并返回解锁票据（可解锁子树内笔记）。"""
    folder = await NoteFolderService.get_folder(db, folder_id)
    if not folder:
        raise NotFoundException("Folder")
    _assert_folder_owner(folder, user)
    if not folder.is_encrypted:
        raise BadRequestException("文件夹未加密")
    remaining = NoteLockService.check_throttle(user.id, "folder", folder.id)
    if remaining:
        raise BadRequestException(f"尝试过于频繁，请 {remaining} 秒后再试")
    key = await NoteLockService.verify_password(db, "folder", folder.id, body.password)
    if not key:
        NoteLockService.record_failure(user.id, "folder", folder.id)
        raise ForbiddenException("密码错误")
    NoteLockService.record_success(user.id, "folder", folder.id)
    token = note_crypto.make_unlock_token(
        scope="folder", target_id=folder.id, user_id=user.id, key_b64=key,
    )
    return FolderLockOut(folder=FolderOut.model_validate(folder), unlock_token=token)


@router.post("/folders/{folder_id}/decrypt", response_model=FolderLockOut)
async def decrypt_folder(
    folder_id: UUID,
    body: PasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """取消文件夹加密：还原子树内用文件夹密钥加密的笔记正文。"""
    folder = await NoteFolderService.get_folder(db, folder_id)
    if not folder:
        raise NotFoundException("Folder")
    _assert_folder_owner(folder, user)
    if not folder.is_encrypted:
        raise BadRequestException("文件夹未加密")
    remaining = NoteLockService.check_throttle(user.id, "folder", folder.id)
    if remaining:
        raise BadRequestException(f"尝试过于频繁，请 {remaining} 秒后再试")
    affected = await NoteLockService.decrypt_folder(db, folder, body.password)
    if affected < 0:
        NoteLockService.record_failure(user.id, "folder", folder.id)
        raise ForbiddenException("密码错误")
    NoteLockService.record_success(user.id, "folder", folder.id)
    return FolderLockOut(folder=FolderOut.model_validate(folder), affected=affected)


@router.get("/templates/list", response_model=list[TemplateOut])
async def list_templates(
    note_type: Optional[str] = None,
    search: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await NoteTemplateService.list_templates(db, note_type=note_type, search=search)


@router.get("/templates/{template_id}", response_model=TemplateOut)
async def get_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = await NoteTemplateService.get_template(db, template_id)
    if not item:
        raise NotFoundException("Template")
    return item


@router.post("/templates", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = body.model_dump()
    data["created_by"] = user.id
    data["updated_by"] = user.id
    data["user_id"] = user.id
    return await NoteTemplateService.create_template(db, data)


@router.patch("/templates/{template_id}", response_model=TemplateOut)
async def update_template(
    template_id: UUID,
    body: TemplateUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = body.model_dump(exclude_unset=True)
    data["updated_by"] = user.id
    item = await NoteTemplateService.update_template(db, template_id, data)
    if not item:
        raise NotFoundException("Template")
    return item


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    ok = await NoteTemplateService.delete_template(db, template_id)
    if not ok:
        raise NotFoundException("Template")


@router.post("/templates/create-from", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def create_note_from_template(
    body: CreateFromTemplateBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteTemplateService.create_note_from_template(
        db, body.template_id, user.id,
        folder_id=body.folder_id, title=body.title,
    )
    if not note:
        raise NotFoundException("Template")
    return await _enrich_note_out(db, note, user)


# ── 图片资产（Base64 内嵌 → Hash 寻址落盘）──
# 注意：必须注册在 `@router.get("/{note_id}")` 之前，否则会被 UUID 路径参数吞掉。

class AssetOut(BaseModel):
    url: str
    hash: str
    size: int


@router.post("/assets", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload_note_asset(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """上传图片资产，返回可写入正文的相对 URL。

    同一张图重复上传会命中相同 SHA-256，直接复用磁盘文件（内容寻址去重）。
    """
    payload = await file.read()
    if len(payload) > MAX_IMAGE_BYTES:
        raise BadRequestException(
            f"图片过大（{len(payload) / 1024 / 1024:.1f}MB > {MAX_IMAGE_BYTES / 1024 / 1024:.0f}MB）",
        )
    result = await NoteAssetService.store_image(
        db, user.id, payload, file.content_type or "",
    )
    return AssetOut(**result)


@router.get("/assets/{asset_name}")
async def get_note_asset(asset_name: str):
    """读取图片资产。

    资产为内容寻址的公共只读资源，文件名即 SHA-256，无需登录；
    但严格校验 64 位十六进制文件名，杜绝任意路径读取。
    """
    path, mime = await read_asset(f"/notes/assets/{asset_name}")
    return FileResponse(path, media_type=mime)


# ── 文档笔记（原文件落盘 + 前端渲染）──

@router.post("/documents", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def upload_document_note(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    folder_id: Optional[UUID] = Form(None),
    description: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    _write_scope: User = Depends(require_write_scope),
    user: User = Depends(require_not_guest),
):
    """上传 PDF / Office / HTML，创建文档笔记并抽取正文。"""
    payload = await file.read()
    limit = document_storage.max_document_bytes()
    if len(payload) > limit:
        raise BadRequestException(
            f"文件过大（{len(payload) / 1024 / 1024:.1f}MB > {limit / 1024 / 1024:.0f}MB）",
        )
    note, document = await document_service.create_document_note(
        db,
        user.id,
        data=payload,
        filename=file.filename or "document",
        folder_id=folder_id,
        title=title,
        description=description,
    )
    return await _enrich_note_out(db, note, user, document=document)


@router.get("/{note_id}/document")
async def download_note_document(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    x_note_unlock: Optional[str] = Header(default=None, alias="X-Note-Unlock"),
):
    """下载/读取文档笔记的原文件；锁定态必须带有效解锁票据。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    lock = await NoteLockService.resolve_lock(db, note)
    if lock and not NoteLockService.resolve_key_from_token(lock, x_note_unlock, user.id):
        raise ForbiddenException("文档已加密，请先解锁")

    document = await document_service.get_document(db, note_id)
    if document is None:
        raise NotFoundException("Document")
    path = document_storage.resolve_path(document.storage_path)
    if path is None:
        raise NotFoundException("Document file")
    return FileResponse(
        path,
        media_type=document.mime,
        filename=document.file_name,
        content_disposition_type="attachment",
        headers={
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Cache-Control": "private, no-cache",
            "ETag": f'"{document.etag}"',
        },
    )


@router.get("/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    x_note_unlock: Optional[str] = Header(default=None, alias="X-Note-Unlock"),
):
    item = await NoteService.get_note(db, note_id)
    if not item:
        raise NotFoundException("Note")
    await _assert_note_access(db, item, user)
    lock = await NoteLockService.resolve_lock(db, item)
    if lock:
        key = NoteLockService.resolve_key_from_token(lock, x_note_unlock, user.id)
        if key:
            plain = note_crypto.decrypt_content(item.content, key)
            if plain is not None:
                # 已解锁：返回明文正文，但保留锁定来源信息
                item.content = plain
                return await _enrich_note_out(db, item, user, lock=lock, is_locked=False)
    return await _enrich_note_out(db, item, user, lock=lock)


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def create_note(
    body: NoteCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_scope),
):
    data = body.model_dump()
    if data.get("note_type") == "document":
        raise BadRequestException("请使用 /notes/documents 上传文档创建笔记")
    data["created_by"] = user.id
    data["updated_by"] = user.id
    note = await NoteService.create_note(db, data)
    return await _enrich_note_out(db, note, user)


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: UUID,
    body: NoteUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_scope),
    x_note_unlock: Optional[str] = Header(default=None, alias="X-Note-Unlock"),
):
    data = body.model_dump(exclude_unset=True)
    data["updated_by"] = user.id
    existing = await NoteService.get_note(db, note_id)
    if not existing:
        raise NotFoundException("Note")
    await _assert_note_edit(db, existing, user)

    if existing.note_type == "document":
        if data.get("content") is not None:
            raise BadRequestException("文档笔记不支持编辑正文")
        if "note_type" in data and data["note_type"] != "document":
            raise BadRequestException("文档笔记不能变更类型")
    elif data.get("note_type") == "document":
        raise BadRequestException("普通笔记不能变更为文档笔记")

    lock = await NoteLockService.resolve_lock(db, existing)
    if lock:
        key = NoteLockService.resolve_key_from_token(lock, x_note_unlock, user.id)
        if not key:
            raise ForbiddenException("文档已加密，请先解锁")
        # 跨保护域移动限制：锁定笔记不得随意移入/移出加密文件夹
        if "folder_id" in data and data["folder_id"] != existing.folder_id:
            if lock[0] == "folder":
                target_lock = await NoteLockService.folder_lock(db, data["folder_id"])
                if target_lock != lock:
                    raise BadRequestException("请先取消文件夹加密，再移动该文档")
            elif await NoteLockService.folder_is_locked(db, data["folder_id"]):
                raise BadRequestException("请先对文档自身加密，再移入加密文件夹")
        # 加密落库：仅当本次修改了正文时才重新加密
        if "content" in data:
            data["content"] = note_crypto.encrypt_content(data["content"], key)
        item = await NoteService.update_note(
            db, note_id, data, save_revision=False, skip_derived=True,
        )
        if not item:
            raise NotFoundException("Note")
        # 本次响应返回明文，但不落库（set_committed_value 避免被 autoflush 写回）
        if "content" in data:
            set_committed_value(item, "content", note_crypto.decrypt_content(item.content, key))
        return await _enrich_note_out(db, item, user, lock=lock, is_locked=False)

    item = await NoteService.update_note(
        db, note_id, data, save_revision=existing.note_type != "document",
    )
    if not item:
        raise NotFoundException("Note")
    return await _enrich_note_out(db, item, user)


# ── 加密 / 解密 / 解锁（笔记） ──

@router.post("/{note_id}/encrypt", response_model=NoteLockOut)
async def encrypt_note(
    note_id: UUID,
    body: PasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """给笔记设置密码并加密正文；返回解锁票据以便当次会话直接可读。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    if note.note_type == "document":
        raise BadRequestException("文档笔记不支持单独加密（原文件不加密存储）")
    if note.is_encrypted:
        raise BadRequestException("文档已加密")
    if await NoteLockService.folder_is_locked(db, note.folder_id):
        raise BadRequestException("该文档已受所在加密文件夹保护，无需单独加密")
    password = body.password.strip()
    if len(password) < 4:
        raise BadRequestException("密码至少 4 位")
    plain = note.content
    key = await NoteLockService.encrypt_note(db, note, password)
    token = note_crypto.make_unlock_token(
        scope="note", target_id=note.id, user_id=user.id, key_b64=key,
    )
    # 本次响应返回明文，但不落库：用 set_committed_value 赋值，避免被 autoflush 写回。
    set_committed_value(note, "content", plain)
    out = await _enrich_note_out(db, note, user, lock=("note", note.id), is_locked=False)
    return NoteLockOut(note=out, unlock_token=token)


@router.post("/{note_id}/decrypt", response_model=NoteLockOut)
async def decrypt_note(
    note_id: UUID,
    body: PasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """取消笔记加密（需正确密码）。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    if not note.is_encrypted:
        if await NoteLockService.folder_is_locked(db, note.folder_id):
            raise BadRequestException("该文档受所在文件夹加密保护，请在文件夹上取消加密")
        raise BadRequestException("文档未加密")
    remaining = NoteLockService.check_throttle(user.id, "note", note.id)
    if remaining:
        raise BadRequestException(f"尝试过于频繁，请 {remaining} 秒后再试")
    if not await NoteLockService.decrypt_note(db, note, body.password):
        NoteLockService.record_failure(user.id, "note", note.id)
        raise ForbiddenException("密码错误")
    NoteLockService.record_success(user.id, "note", note.id)
    out = await _enrich_note_out(db, note, user, lock=None)
    return NoteLockOut(note=out, unlock_token=None)


@router.post("/{note_id}/unlock", response_model=NoteLockOut)
async def unlock_note(
    note_id: UUID,
    body: PasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """校验密码并返回解锁票据；票据覆盖笔记自身加密或所属加密文件夹。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    lock = await NoteLockService.resolve_lock(db, note)
    if not lock:
        raise BadRequestException("文档未加密")
    scope, target_id = lock
    remaining = NoteLockService.check_throttle(user.id, scope, target_id)
    if remaining:
        raise BadRequestException(f"尝试过于频繁，请 {remaining} 秒后再试")
    key = await NoteLockService.verify_password(db, scope, target_id, body.password)
    if not key:
        NoteLockService.record_failure(user.id, scope, target_id)
        raise ForbiddenException("密码错误")
    NoteLockService.record_success(user.id, scope, target_id)
    token = note_crypto.make_unlock_token(
        scope=scope, target_id=target_id, user_id=user.id, key_b64=key,
    )
    plain = note_crypto.decrypt_content(note.content, key)
    if plain is not None:
        set_committed_value(note, "content", plain)  # 仅本次响应返回明文，不落库
    out = await _enrich_note_out(db, note, user, lock=lock, is_locked=False)
    return NoteLockOut(note=out, unlock_token=token)


@router.post("/{note_id}/change-password", response_model=NoteLockOut)
async def change_note_password(
    note_id: UUID,
    body: ChangePasswordBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """修改笔记加密密码（需提供原密码）。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    if not note.is_encrypted:
        raise BadRequestException("文档未加密")
    new_password = body.new_password.strip()
    if len(new_password) < 4:
        raise BadRequestException("新密码至少 4 位")
    if not note.enc_verifier or not AuthService.verify_password(body.old_password, note.enc_verifier):
        raise ForbiddenException("原密码错误")
    old_key = note_crypto.derive_fernet_key(body.old_password, note.enc_salt or "")
    plain = note_crypto.decrypt_content(note.content, old_key)
    if plain is None:
        raise BadRequestException("解密失败，无法修改密码")
    new_salt = note_crypto.new_salt()
    new_key = note_crypto.derive_fernet_key(new_password, new_salt)
    note.enc_salt = new_salt
    note.enc_verifier = AuthService.hash_password(new_password)
    note.content = note_crypto.encrypt_content(plain, new_key)
    await db.commit()
    await db.refresh(note)
    token = note_crypto.make_unlock_token(
        scope="note", target_id=note.id, user_id=user.id, key_b64=new_key,
    )
    set_committed_value(note, "content", plain)  # 仅本次响应返回明文，不落库
    out = await _enrich_note_out(db, note, user, lock=("note", note.id), is_locked=False)
    return NoteLockOut(note=out, unlock_token=token)


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_scope),
):
    existing = await NoteService.get_note(db, note_id)
    if not existing:
        raise NotFoundException("Note")
    _assert_note_owner(existing, user)
    ok = await NoteService.delete_note(db, note_id)
    if not ok:
        raise NotFoundException("Note")


@router.post("/{note_id}/duplicate", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def duplicate_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    original = await NoteService.get_note(db, note_id)
    if not original:
        raise NotFoundException("Note")
    _assert_note_owner(original, user)
    if await NoteLockService.resolve_lock(db, original):
        raise BadRequestException("加密文档不支持复制")
    copied = await NoteService.duplicate_note(db, note_id, user.id)
    if not copied:
        raise NotFoundException("Note")
    if original.note_type == "document":
        await document_service.duplicate_document(db, note_id, copied.id)
    return await _enrich_note_out(db, copied, user)


@router.post("/{note_id}/append", response_model=NoteOut)
async def append_to_note(
    note_id: UUID,
    body: NoteAppend,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """向笔记末尾追加内容。

    供 MCP 等外部集成直接写入，主动作由使用者在 Agent 侧发起，
    因此不做二次确认；但仍保留编辑权限校验与自动修订记录。
    仅支持 markdown / rich_text 两种笔记类型。
    """
    existing = await NoteService.get_note(db, note_id)
    if not existing:
        raise NotFoundException("Note")
    await _assert_note_edit(db, existing, user)
    if await NoteLockService.resolve_lock(db, existing):
        raise ForbiddenException("加密文档不支持追加内容")
    item, error = await NoteService.append_text(db, note_id, user.id, body.text)
    if error or item is None:
        raise BadRequestException(error or "追加失败")
    return await _enrich_note_out(db, item, user)


@router.post("/{note_id}/restore", response_model=NoteOut)
async def restore_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    existing = await NoteService.get_note_any(db, note_id)
    if not existing:
        raise NotFoundException("Note")
    _assert_note_owner(existing, user)
    item = await NoteService.restore_note(db, note_id)
    if not item:
        raise NotFoundException("Note")
    return await _enrich_note_out(db, item, user)


@router.delete("/{note_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def permanently_delete_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    existing = await NoteService.get_note_any(db, note_id)
    if not existing:
        raise NotFoundException("Note")
    _assert_note_owner(existing, user)
    if not existing.is_deleted:
        raise BadRequestException("请先将笔记移入回收站，再永久删除")
    await document_service.delete_document_for_note(db, note_id)
    ok = await NoteService.permanently_delete_note(db, note_id)
    if not ok:
        raise NotFoundException("Note")


@router.post("/{note_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def add_tag_to_note(
    note_id: UUID,
    tag_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    ok = await NoteTagService.add_tag_to_note(db, note_id, tag_id, user.id)
    if not ok:
        raise NotFoundException("Tag")


@router.delete("/{note_id}/tags/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_tag_from_note(
    note_id: UUID,
    tag_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    await NoteTagService.remove_tag_from_note(db, note_id, tag_id)


# ── Favorites ──

@router.post("/{note_id}/favorite", status_code=status.HTTP_204_NO_CONTENT)
async def add_favorite(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    await NoteFavoriteService.add_favorite(db, user.id, note_id)


@router.delete("/{note_id}/favorite", status_code=status.HTTP_204_NO_CONTENT)
async def remove_favorite(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await NoteFavoriteService.remove_favorite(db, user.id, note_id)


# ── Backlinks ──

@router.get("/{note_id}/backlinks", response_model=list[BacklinkOut])
async def get_backlinks(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    return await NoteLinkService.get_backlinks(db, note_id)


# ── Related notes / suggestions ──

@router.get("/{note_id}/related", response_model=list[RelatedNoteOut])
async def get_related_notes(
    note_id: UUID,
    limit: int = Query(6, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    from app.services.ai.related_service import RelatedNoteService

    return await RelatedNoteService.related(db, user.id, note, limit=limit)


@router.post("/{note_id}/related/{target_id}/link")
async def link_related_note(
    note_id: UUID,
    target_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """在来源笔记末尾追加一条 `[[目标标题]]`，建立可解析的双向链接。"""
    source = await NoteService.get_note(db, note_id)
    target = await NoteService.get_note(db, target_id)
    if not source or not target:
        raise NotFoundException("Note")
    await _assert_note_access(db, source, user)
    await _assert_note_access(db, target, user)

    updated, error = await NoteService.append_text(
        db, note_id, user.id, f"\n\n[[{target.title}]]",
    )
    if updated is None:
        raise BadRequestException(error or "该笔记类型不支持自动插入链接")
    return {"success": True, "noteId": str(note_id), "targetId": str(target_id)}


@router.get("/{note_id}/tag-suggestions", response_model=list[TagSuggestionOut])
async def suggest_tags(
    note_id: UUID,
    limit: int = Query(5, ge=1, le=10),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    from app.services.note.tag_suggestion_service import TagSuggestionService

    return await TagSuggestionService.suggest(db, user.id, note, limit=limit)


# ── Public read-only link ──

@router.post("/{note_id}/public-link", response_model=PublicLinkOut)
async def create_public_link(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    if note.is_encrypted:
        raise BadRequestException("加密笔记不能创建公开链接")
    if await NoteLockService.resolve_lock(db, note):
        raise BadRequestException("加密笔记不能创建公开链接")
    from app.services.note.public_link_service import NotePublicLinkService

    link = await NotePublicLinkService.create_or_get(db, note, user.id)
    return PublicLinkOut(
        token=link.token,
        expiresAt=link.expires_at.isoformat() if link.expires_at else None,
    )


@router.delete("/{note_id}/public-link")
async def revoke_public_link(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    from app.services.note.public_link_service import NotePublicLinkService

    removed = await NotePublicLinkService.revoke(db, note_id)
    return {"success": True, "revoked": removed}


@router.get("/{note_id}/chunks/{chunk_id}", response_model=RagChunkOut)
async def get_rag_chunk(
    note_id: UUID,
    chunk_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """AI 引用跳转：取回被引用的块原文，供编辑器定位与校验。"""
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    from app.services.ai.rag_v2_service import RagV2Service

    chunk = await RagV2Service.get_chunk(db, user.id, note_id, chunk_id)
    if chunk is None:
        raise NotFoundException("RAG chunk")
    return chunk


# ── Daily note / review ──

@router.get("/daily/today", response_model=NoteOut)
async def get_daily_note(
    date: Optional[str] = Query(None, description="YYYY-MM-DD，默认今天"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.services.note.daily_service import DailyNoteService

    note = await DailyNoteService.ensure_daily_note(db, user.id, date)
    enriched = await _enrich_notes_batch(db, [note], user, include_content=True)
    return enriched[0]


@router.post("/daily/review")
async def daily_review(
    date: Optional[str] = Query(None, description="YYYY-MM-DD，默认今天"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.services.note.daily_service import DailyNoteService

    return await DailyNoteService.build_review(db, user.id, date)


# ── Revisions ──

@router.get("/{note_id}/revisions", response_model=list[RevisionOut])
async def list_revisions(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_access(db, note, user)
    return await NoteRevisionService.list_revisions(db, note_id)


@router.post("/{note_id}/revisions/{revision_id}/restore", response_model=NoteOut)
async def restore_revision(
    note_id: UUID,
    revision_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    await _assert_note_edit(db, note, user)
    item = await NoteRevisionService.restore_revision(db, note_id, revision_id, user.id)
    if not item:
        raise NotFoundException("Revision")
    return await _enrich_note_out(db, item, user)


# ── Shares ──

@router.get("/{note_id}/shares", response_model=list[ShareOut])
async def list_shares(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    return await NoteShareService.list_shares(db, note_id)


@router.post("/{note_id}/shares", response_model=ShareOut, status_code=status.HTTP_201_CREATED)
async def add_share(
    note_id: UUID,
    body: ShareCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    if body.permission not in ("view", "edit"):
        raise BadRequestException("Invalid permission")
    return await NoteShareService.add_share(
        db, note_id, body.shared_with_user_id, body.permission, user.id,
    )


@router.delete("/{note_id}/shares/{shared_user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_share(
    note_id: UUID,
    shared_user_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    note = await NoteService.get_note(db, note_id)
    if not note:
        raise NotFoundException("Note")
    _assert_note_owner(note, user)
    ok = await NoteShareService.remove_share(db, note_id, shared_user_id)
    if not ok:
        raise NotFoundException("Share")
