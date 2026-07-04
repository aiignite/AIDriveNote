"""Note Management router – 笔记管理 API."""
from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.auth import get_current_user
from app.models.user import User
from app.models.note.note import Note, NoteFolder
from app.services.note.note_service import NoteService, NoteFolderService, NoteTemplateService
from app.services.note.note_enhance_service import (
    NoteFavoriteService,
    NoteLinkService,
    NoteRevisionService,
    NoteShareService,
    NoteSearchService,
    NoteTagService,
    note_preview_text,
)
from app.exceptions import BadRequestException, ConflictException, ForbiddenException, NotFoundException

router = APIRouter(prefix="/notes", tags=["Notes"])


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


# ── Note Schemas ──

class NoteCreate(BaseModel):
    title: str
    note_type: str
    content: Optional[dict] = None
    folder_id: Optional[UUID] = None
    description: Optional[str] = None
    status: Optional[str] = "Active"


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    note_type: Optional[str] = None
    content: Optional[dict] = None
    folder_id: Optional[UUID] = None
    description: Optional[str] = None
    status: Optional[str] = None
    is_pinned: Optional[bool] = None


class NoteOut(BaseModel):
    model_config = {"from_attributes": True}
    id: UUID
    note_no: str
    title: str
    note_type: str
    content: Optional[dict] = None
    folder_id: Optional[UUID] = None
    description: Optional[str] = None
    status: str
    is_pinned: bool = False
    is_deleted: bool
    deleted_at: Optional[datetime] = None
    created_by: Optional[UUID] = None
    updated_by: Optional[UUID] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    preview_text: Optional[str] = None
    is_favorite: bool = False
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


class SearchResultOut(BaseModel):
    items: list[NoteOut]
    total: int
    highlights: dict[str, str] = {}


async def _enrich_note_out(
    db: AsyncSession,
    note: Note,
    user: User,
    *,
    tags: list | None = None,
    is_favorite: bool | None = None,
) -> NoteOut:
    if tags is None:
        tags = await NoteTagService.get_note_tags(db, note.id)
    if is_favorite is None:
        is_favorite = await NoteFavoriteService.is_favorited(db, user.id, note.id)
    return NoteOut(
        id=note.id,
        note_no=note.note_no,
        title=note.title,
        note_type=note.note_type,
        content=note.content,
        folder_id=note.folder_id,
        description=note.description,
        status=note.status,
        is_pinned=note.is_pinned,
        is_deleted=note.is_deleted,
        deleted_at=note.deleted_at,
        created_by=note.created_by,
        updated_by=note.updated_by,
        created_at=note.created_at,
        updated_at=note.updated_at,
        preview_text=note_preview_text(note),
        is_favorite=is_favorite,
        tags=[TagOut.model_validate(t) for t in tags],
    )


async def _enrich_notes_batch(db: AsyncSession, notes: list[Note], user: User) -> list[NoteOut]:
    if not notes:
        return []
    note_ids = [n.id for n in notes]
    tags_map = await NoteTagService.get_tags_for_notes(db, note_ids)
    fav_ids = await NoteFavoriteService.get_favorited_note_ids(db, user.id, note_ids)
    return [
        await _enrich_note_out(
            db, note, user,
            tags=tags_map.get(note.id, []),
            is_favorite=note.id in fav_ids,
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
    skip: int = 0,
    limit: int = 100,
    search: Optional[str] = None,
    note_type: Optional[str] = None,
    folder_id: Optional[str] = None,
    status: Optional[str] = None,
    is_pinned: Optional[bool] = None,
    is_favorite: Optional[bool] = None,
    tag_ids: Optional[str] = None,
    include_shared: bool = False,
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
    enriched = await _enrich_notes_batch(db, items, user)
    return NoteListOut(items=enriched, total=total)


@router.get("/trash/list", response_model=NoteListOut)
async def list_trash_notes(
    skip: int = 0,
    limit: int = 100,
    search: Optional[str] = None,
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
    enriched = await _enrich_notes_batch(db, items, user)
    return NoteListOut(items=enriched, total=total)


@router.get("/search/fulltext", response_model=SearchResultOut)
async def search_notes_fulltext(
    q: str,
    skip: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    items, total = await NoteSearchService.full_text_search(
        db, user_id=user.id, query=q, skip=skip, limit=limit,
    )
    enriched = await _enrich_notes_batch(db, items, user)
    highlights = {str(n.id): note_preview_text(n, 200) for n in items}
    return SearchResultOut(items=enriched, total=total, highlights=highlights)


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
    item = await NoteFolderService.update_folder(
        db, folder_id, body.model_dump(exclude_unset=True),
    )
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
    ok = await NoteFolderService.delete_folder(db, folder_id)
    if not ok:
        raise NotFoundException("Folder")


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


@router.get("/{note_id}", response_model=NoteOut)
async def get_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    item = await NoteService.get_note(db, note_id)
    if not item:
        raise NotFoundException("Note")
    await _assert_note_access(db, item, user)
    return await _enrich_note_out(db, item, user)


@router.post("", response_model=NoteOut, status_code=status.HTTP_201_CREATED)
async def create_note(
    body: NoteCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = body.model_dump()
    data["created_by"] = user.id
    data["updated_by"] = user.id
    note = await NoteService.create_note(db, data)
    return await _enrich_note_out(db, note, user)


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: UUID,
    body: NoteUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = body.model_dump(exclude_unset=True)
    data["updated_by"] = user.id
    existing = await NoteService.get_note(db, note_id)
    if not existing:
        raise NotFoundException("Note")
    await _assert_note_edit(db, existing, user)
    item = await NoteService.update_note(db, note_id, data)
    if not item:
        raise NotFoundException("Note")
    return await _enrich_note_out(db, item, user)


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(
    note_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
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
    copied = await NoteService.duplicate_note(db, note_id, user.id)
    if not copied:
        raise NotFoundException("Note")
    return await _enrich_note_out(db, copied, user)


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
