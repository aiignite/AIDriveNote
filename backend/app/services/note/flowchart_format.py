"""draw.io mxGraphModel XML 规范化 — 供 AI 工具写入流程图时使用。"""
from __future__ import annotations

import re
from typing import Any

_CODE_FENCE_RE = re.compile(r"^```(?:xml|drawio|html)?\s*\n?(.*?)\n?```$", re.DOTALL | re.IGNORECASE)


def normalize_flowchart_xml(xml: str) -> str:
    """将 AI 输出的片段规范为 draw.io 可加载的 mxGraphModel XML。"""
    text = (xml or "").strip()
    if not text:
        return text

    fence = _CODE_FENCE_RE.match(text)
    if fence:
        text = fence.group(1).strip()

    if "<mxGraphModel" not in text and "<mxCell" in text:
        text = (
            '<mxGraphModel dx="1422" dy="794" grid="1" gridSize="10" guides="1" '
            'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
            'pageWidth="1169" pageHeight="827" math="0" shadow="0">'
            f"<root>{text}</root></mxGraphModel>"
        )
    elif "<mxGraphModel" in text and "<root>" not in text:
        text = text.replace("<mxGraphModel", "<mxGraphModel><root>", 1)
        text = text.replace("</mxGraphModel>", "</root></mxGraphModel>", 1)

    if "mxCell" in text and 'id="0"' not in text and "id='0'" not in text:
        insert_at = text.find("<root>")
        if insert_at >= 0:
            pos = insert_at + len("<root>")
            text = text[:pos] + '<mxCell id="0"/><mxCell id="1" parent="0"/>' + text[pos:]

    return text


def normalize_flowchart_content(content: dict[str, Any]) -> dict[str, Any]:
    return {"xml": normalize_flowchart_xml(str(content.get("xml") or ""))}
