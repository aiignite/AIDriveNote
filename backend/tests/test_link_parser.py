"""Tests for wiki link parsing and search text extraction."""
from app.services.note.link_parser import build_search_text, extract_wiki_links


def test_extract_wiki_links_from_markdown() -> None:
    content = {"text": "See [[Meeting Notes]] and [[NT2026000001]] for details."}
    links = extract_wiki_links(content, "markdown")
    assert links == ["Meeting Notes", "NT2026000001"]


def test_extract_wiki_links_deduplicates() -> None:
    content = {"text": "[[Same]] and again [[Same]]"}
    links = extract_wiki_links(content, "markdown")
    assert links == ["Same"]


def test_extract_wiki_links_ignores_mindmap() -> None:
    content = {"data": {"text": "root"}, "children": []}
    assert extract_wiki_links(content, "mindmap") == []


def test_build_search_text_includes_title_and_body() -> None:
    text = build_search_text(
        "Project Plan",
        "Quarterly goals",
        {"text": "Deliver [[Milestone A]]"},
        "markdown",
    )
    assert "Project Plan" in text
    assert "Quarterly goals" in text
    assert "Deliver" in text


def test_build_search_text_rich_text_blocks() -> None:
    text = build_search_text(
        "Rich Note",
        None,
        {"blocks": [{"type": "paragraph", "props": {}, "content": [{"type": "text", "text": "Hello"}]}]},
        "rich_text",
    )
    assert "Rich Note" in text
    assert "Hello" in text


def test_extract_wiki_links_from_rich_text() -> None:
    content = {
        "blocks": [{
            "type": "paragraph",
            "props": {},
            "content": [{"type": "text", "text": "See [[Other Note]]"}],
        }],
    }
    links = extract_wiki_links(content, "rich_text")
    assert links == ["Other Note"]
