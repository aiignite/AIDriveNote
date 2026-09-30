"""Tests for document attachment text extraction."""
from __future__ import annotations

import tempfile
from pathlib import Path

from app.models.ai import AIAttachment
from app.services.ai.attachment_service import AttachmentService


def test_extract_text_file():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write("Hello PDF companion\n第二行")
        path = f.name
    try:
        att = AIAttachment(
            user_id=None,  # type: ignore[arg-type]
            file_name="x.txt",
            original_name="notes.txt",
            file_size=1,
            mime_type="text/plain",
            file_path=path,
        )
        content = AttachmentService._extract_file_content(att, path)
        assert content is not None
        assert "Hello PDF companion" in content
        assert "第二行" in content
    finally:
        Path(path).unlink(missing_ok=True)


def test_extract_pdf_content_handles_errors():
    result = AttachmentService._extract_pdf_content("/nonexistent/missing.pdf")
    assert result is not None
    assert "PDF 读取失败" in result or "未能提取" in result


def test_extract_xlsx_content():
    from openpyxl import Workbook

    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
        path = f.name
    try:
        wb = Workbook()
        ws = wb.active
        ws.title = "数据"
        ws.append(["姓名", "数量"])
        ws.append(["苹果", 10])
        ws.append(["香蕉", 5])
        wb.save(path)
        wb.close()

        att = AIAttachment(
            user_id=None,  # type: ignore[arg-type]
            file_name="data.xlsx",
            original_name="report.xlsx",
            file_size=1,
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            file_path=path,
        )
        content = AttachmentService._extract_file_content(att, path)
        assert content is not None
        assert "工作表: 数据" in content
        assert "姓名 | 数量" in content
        assert "苹果 | 10" in content
        assert "香蕉 | 5" in content
    finally:
        Path(path).unlink(missing_ok=True)


def test_extract_xls_legacy_not_supported():
    att = AIAttachment(
        user_id=None,  # type: ignore[arg-type]
        file_name="legacy.xls",
        original_name="legacy.xls",
        file_size=1,
        mime_type="application/vnd.ms-excel",
        file_path="/tmp/unused.xls",
    )
    content = AttachmentService._extract_xlsx_content(
        "/tmp/unused.xls",
        original_name="legacy.xls",
    )
    assert content is not None
    assert "暂不支持" in content
