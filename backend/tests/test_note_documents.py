"""文档笔记：上传、落盘、下载、搜索、公开链接与删除清理。"""
from __future__ import annotations

import io
import uuid

import bcrypt
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.services.note import document_storage


def _docx_bytes(text: str = "验收标准：设备噪声不得超过 75 分贝。") -> bytes:
    from docx import Document

    document = Document()
    document.add_paragraph(text)
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def _pdf_bytes() -> bytes:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


async def _create_user(db: AsyncSession, email: str) -> User:
    hashed = bcrypt.hashpw(b"test_password", bcrypt.gensalt(12)).decode("utf-8")
    user = User(email=email, password_hash=hashed, name=email.split("@")[0])
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest_asyncio.fixture
async def doc_env(db_session: AsyncSession, tmp_path, monkeypatch):
    """带登录态的客户端 + 隔离的上传目录。"""
    from app.auth import get_current_user
    from app.main import app

    monkeypatch.setattr(document_storage, "_root", lambda: tmp_path)
    user = await _create_user(db_session, "docs@test.com")
    other = await _create_user(db_session, "other@test.com")

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = lambda: user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as client:
        yield client, user, other, tmp_path

    app.dependency_overrides.clear()


async def _upload(client: AsyncClient, name: str, payload: bytes, mime: str):
    return await client.post(
        "/notes/documents",
        files={"file": (name, payload, mime)},
        data={"title": "文档测试"},
    )


@pytest.mark.asyncio
async def test_upload_docx_creates_document_note(doc_env):
    client, _user, _other, tmp_path = doc_env
    res = await _upload(
        client,
        "spec.docx",
        _docx_bytes(),
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["note_type"] == "document"
    assert body["content"] is None
    assert body["document"]["file_name"] == "spec.docx"
    assert body["document"]["viewable"] is True
    assert body["document"]["extract_status"] == "ok"
    stored = list((tmp_path / "documents").rglob("*.docx"))
    assert len(stored) == 1


@pytest.mark.asyncio
async def test_upload_pdf_and_download_headers(doc_env):
    client, _user, _other, _tmp = doc_env
    res = await _upload(client, "a.pdf", _pdf_bytes(), "application/pdf")
    assert res.status_code == 201, res.text
    note_id = res.json()["id"]

    download = await client.get(f"/notes/{note_id}/document")
    assert download.status_code == 200
    assert download.headers["content-disposition"].startswith("attachment")
    assert "sandbox" in download.headers["content-security-policy"]
    assert download.headers["x-content-type-options"] == "nosniff"
    assert download.content.startswith(b"%PDF-")


@pytest.mark.asyncio
async def test_html_is_served_as_attachment_with_csp(doc_env):
    client, _user, _other, _tmp = doc_env
    payload = b"<html><body><h1>Hello</h1><script>alert(1)</script></body></html>"
    res = await _upload(client, "page.html", payload, "text/html")
    assert res.status_code == 201, res.text
    note_id = res.json()["id"]
    download = await client.get(f"/notes/{note_id}/document")
    assert download.status_code == 200
    assert "sandbox" in download.headers["content-security-policy"]


@pytest.mark.asyncio
async def test_rejects_fake_extension_and_oversize(doc_env, monkeypatch):
    client, _user, _other, _tmp = doc_env
    bad = await _upload(client, "evil.pdf", b"not a pdf", "application/pdf")
    assert bad.status_code == 400

    monkeypatch.setattr(document_storage, "max_document_bytes", lambda: 10)
    too_big = await _upload(client, "a.pdf", _pdf_bytes(), "application/pdf")
    assert too_big.status_code == 400


@pytest.mark.asyncio
async def test_download_is_owner_only(doc_env):
    client, _user, other, _tmp = doc_env
    from app.auth import get_current_user
    from app.main import app

    res = await _upload(client, "a.pdf", _pdf_bytes(), "application/pdf")
    note_id = res.json()["id"]

    app.dependency_overrides[get_current_user] = lambda: other
    forbidden = await client.get(f"/notes/{note_id}/document")
    assert forbidden.status_code == 403
    app.dependency_overrides[get_current_user] = lambda: _user


@pytest.mark.asyncio
async def test_search_uses_extracted_text(doc_env):
    client, _user, _other, _tmp = doc_env
    res = await _upload(client, "spec.docx", _docx_bytes(), "application/octet-stream")
    assert res.status_code == 201, res.text

    found = await client.get("/notes", params={"search": "验收标准"})
    assert found.status_code == 200
    items = found.json()["items"]
    assert any(item["note_type"] == "document" for item in items)


@pytest.mark.asyncio
async def test_duplicate_and_permanent_delete(doc_env):
    client, _user, _other, tmp_path = doc_env
    res = await _upload(client, "a.pdf", _pdf_bytes(), "application/pdf")
    note_id = res.json()["id"]
    stored = list((tmp_path / "documents").rglob("*.pdf"))
    assert len(stored) == 1

    copied = await client.post(f"/notes/{note_id}/duplicate")
    assert copied.status_code == 201, copied.text
    assert copied.json()["document"]["file_name"] == "a.pdf"

    await client.delete(f"/notes/{note_id}")
    assert stored[0].exists(), "软删除必须保留原文件"
    await client.delete(f"/notes/{note_id}/permanent")
    # 副本仍引用同一文件，因此不能被删除
    assert stored[0].exists()

    copied_id = copied.json()["id"]
    await client.delete(f"/notes/{copied_id}")
    await client.delete(f"/notes/{copied_id}/permanent")
    assert not stored[0].exists()


@pytest.mark.asyncio
async def test_public_link_document_download(doc_env):
    client, _user, _other, _tmp = doc_env
    res = await _upload(client, "a.pdf", _pdf_bytes(), "application/pdf")
    note_id = res.json()["id"]

    link = await client.post(f"/notes/{note_id}/public-link")
    assert link.status_code == 200, link.text
    token = link.json()["token"]

    public = await client.get(f"/public/notes/{token}")
    assert public.status_code == 200
    assert public.json()["noteType"] == "document"
    download = await client.get(f"/public/notes/{token}/document")
    assert download.status_code == 200

    await client.delete(f"/notes/{note_id}/public-link")
    revoked = await client.get(f"/public/notes/{token}/document")
    assert revoked.status_code == 404


@pytest.mark.asyncio
async def test_document_note_rejects_content_update(doc_env):
    client, _user, _other, _tmp = doc_env
    res = await _upload(client, "a.pdf", _pdf_bytes(), "application/pdf")
    note_id = res.json()["id"]
    update = await client.patch(f"/notes/{note_id}", json={"content": {"text": "x"}})
    assert update.status_code == 400
    rename = await client.patch(f"/notes/{note_id}", json={"title": "新标题"})
    assert rename.status_code == 200
    assert rename.json()["title"] == "新标题"


def test_sniff_rejects_mismatched_zip(tmp_path, monkeypatch):
    monkeypatch.setattr(document_storage, "_root", lambda: tmp_path)
    from app.exceptions import BadRequestException

    with pytest.raises(BadRequestException):
        document_storage.store(_docx_bytes(), "wrong.xlsx")
