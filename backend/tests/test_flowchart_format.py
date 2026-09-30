"""Tests for draw.io flowchart XML normalization."""
from __future__ import annotations

from app.services.note.flowchart_format import normalize_flowchart_content, normalize_flowchart_xml


def test_normalize_wraps_bare_mxcell():
    raw = '<mxCell id="2" value="开始" vertex="1" parent="1"/>'
    out = normalize_flowchart_xml(raw)
    assert "<mxGraphModel" in out
    assert "<root>" in out
    assert 'value="开始"' in out
    assert 'id="0"' in out


def test_normalize_strips_code_fence():
    raw = "```xml\n<mxCell id=\"2\" value=\"A\" vertex=\"1\" parent=\"1\"/>\n```"
    out = normalize_flowchart_xml(raw)
    assert "<mxGraphModel" in out
    assert "```" not in out


def test_normalize_flowchart_content_dict():
    out = normalize_flowchart_content({"xml": '<mxCell id="2" value="B"/>'})
    assert out["xml"].startswith("<mxGraphModel")
