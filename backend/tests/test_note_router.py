"""Tests for note ownership, duplicate, and folder delete behavior."""
from __future__ import annotations

import uuid

import bcrypt
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import importlib.util
from pathlib import Path

_sqlite_types_path = Path(__file__).parent / "sqlite_types.py"
_spec = importlib.util.spec_from_file_location("_aidrive_sqlite_types", _sqlite_types_path)
_mod = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(_mod)

from app.models.note.note import Note, NoteFolder, NoteLink, NoteRevision
from app.models.user import User
from app.routers.note.note import _assert_folder_owner, _assert_note_owner
from app.services.note.note_service import NoteFolderService, NoteService
from app.exceptions import ForbiddenException

NOTE_TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
note_test_engine = create_async_engine(NOTE_TEST_DB_URL, echo=False)
NoteTestSession = async_sessionmaker(note_test_engine, class_=AsyncSession, expire_on_commit=False)


@pytest_asyncio.fixture
async def note_db() -> AsyncSession:
    """Minimal DB with only user + note tables (avoids full-schema SQLite issues)."""
    async with note_test_engine.begin() as conn:
        await conn.run_sync(lambda sync: User.__table__.create(sync, checkfirst=True))
        await conn.run_sync(lambda sync: NoteFolder.__table__.create(sync, checkfirst=True))
        await conn.run_sync(lambda sync: Note.__table__.create(sync, checkfirst=True))
        await conn.run_sync(lambda sync: NoteLink.__table__.create(sync, checkfirst=True))
        await conn.run_sync(lambda sync: NoteRevision.__table__.create(sync, checkfirst=True))

    async with NoteTestSession() as session:
        yield session

    async with note_test_engine.begin() as conn:
        await conn.run_sync(lambda sync: NoteRevision.__table__.drop(sync, checkfirst=True))
        await conn.run_sync(lambda sync: NoteLink.__table__.drop(sync, checkfirst=True))
        await conn.run_sync(lambda sync: Note.__table__.drop(sync, checkfirst=True))
        await conn.run_sync(lambda sync: NoteFolder.__table__.drop(sync, checkfirst=True))
        await conn.run_sync(lambda sync: User.__table__.drop(sync, checkfirst=True))


async def _create_user(db: AsyncSession, email: str, name: str) -> User:
    hashed = bcrypt.hashpw(b"test_password", bcrypt.gensalt(12)).decode("utf-8")
    user = User(email=email, password_hash=hashed, name=name)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


def test_assert_note_owner_allows_creator() -> None:
    user_id = uuid.uuid4()
    note = Note(
        note_no="NT2026000001",
        title="Mine",
        note_type="markdown",
        created_by=user_id,
    )
    user = User(email="a@test.com", password_hash="x", name="A")
    user.id = user_id
    _assert_note_owner(note, user)


def test_assert_note_owner_blocks_other_user() -> None:
    owner_id = uuid.uuid4()
    other_id = uuid.uuid4()
    note = Note(
        note_no="NT2026000001",
        title="Private",
        note_type="markdown",
        created_by=owner_id,
    )
    user = User(email="b@test.com", password_hash="x", name="B")
    user.id = other_id
    with pytest.raises(ForbiddenException):
        _assert_note_owner(note, user)


def test_assert_folder_owner_blocks_other_user() -> None:
    owner_id = uuid.uuid4()
    other_id = uuid.uuid4()
    folder = NoteFolder(name="Work", user_id=owner_id)
    user = User(email="c@test.com", password_hash="x", name="C")
    user.id = other_id
    with pytest.raises(ForbiddenException):
        _assert_folder_owner(folder, user)


@pytest.mark.asyncio
async def test_create_note_returns_fresh_instance(note_db: AsyncSession) -> None:
    """Post-commit search/link sync must not expire the returned ORM object."""
    user = await _create_user(note_db, "create-fresh@test.com", "CreateFresh")
    note = await NoteService.create_note(note_db, {
        "title": "Fresh Return",
        "note_type": "markdown",
        "content": {"text": "hello"},
        "created_by": user.id,
        "updated_by": user.id,
    })
    assert note is not None
    assert note.title == "Fresh Return"
    # Accessing attributes must not raise MissingGreenlet
    assert note.updated_at is not None
    assert note.note_no.startswith("NT")
    user = await _create_user(note_db, "dup@test.com", "Dup")
    original = await NoteService.create_note(note_db, {
        "title": "Original",
        "note_type": "markdown",
        "content": {"text": "# hi"},
        "created_by": user.id,
        "updated_by": user.id,
    })
    copied = await NoteService.duplicate_note(note_db, original.id, user.id)
    assert copied is not None
    assert copied.id != original.id
    assert copied.note_no != original.note_no
    assert copied.note_no.startswith("NT")


@pytest.mark.asyncio
async def test_delete_folder_clears_note_folder_id(note_db: AsyncSession) -> None:
    user = await _create_user(note_db, "fold@test.com", "Fold")
    folder = await NoteFolderService.create_folder(note_db, {
        "name": "Work",
        "user_id": user.id,
    })
    note = await NoteService.create_note(note_db, {
        "title": "In folder",
        "note_type": "markdown",
        "folder_id": folder.id,
        "created_by": user.id,
        "updated_by": user.id,
    })
    assert note.folder_id == folder.id

    ok = await NoteFolderService.delete_folder(note_db, folder.id)
    assert ok is True

    refreshed = await NoteService.get_note(note_db, note.id)
    assert refreshed is not None
    assert refreshed.folder_id is None


@pytest.mark.asyncio
async def test_delete_folder_cascades_soft_delete_child_folders(note_db: AsyncSession) -> None:
    user = await _create_user(note_db, "cascade@test.com", "Cascade")
    parent = await NoteFolderService.create_folder(note_db, {
        "name": "Parent",
        "user_id": user.id,
    })
    child = await NoteFolderService.create_folder(note_db, {
        "name": "Child",
        "parent_id": parent.id,
        "user_id": user.id,
    })

    ok = await NoteFolderService.delete_folder(note_db, parent.id)
    assert ok is True

    deleted_parent = await NoteFolderService.get_folder(note_db, parent.id)
    deleted_child = await NoteFolderService.get_folder(note_db, child.id)
    assert deleted_parent is None
    assert deleted_child is None
