"""规则层关键词 / 实体 / 知识类型判定。

标签建议服务复用这里的停用词与分词正则，避免两套规则漂移。
"""
from __future__ import annotations

import re
from collections import Counter

STOPWORDS = {
    "我们", "你们", "他们", "这个", "那个", "可以", "需要", "进行", "通过",
    "以及", "但是", "如果", "因为", "所以", "已经", "没有", "一个", "什么",
    "自己", "现在", "时候", "问题", "内容", "笔记", "相关", "主要", "同时",
    "目前", "之后", "其中", "并且", "或者", "就是", "不是", "还是",
    "以及", "对于", "关于", "由于", "因此", "然而", "这样", "这些", "那些",
}

TOKEN_RE = re.compile(r"[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_+-]{2,}")

_BRACKET_ENTITY_RE = re.compile(r"[《「【]([^》」】]{2,40})[》」】]")
_LATIN_NAME_RE = re.compile(r"\b[A-Z][A-Za-z0-9]{1,30}\b")

_DECISION_HINTS = ("决定", "决策", "选型", "方案", "取舍", "结论", "拍板", "对比")
_CONCEPT_HINTS = ("是什么", "定义", "概念", "原理", "解释", "含义")
_ENTITY_HINTS = ("公司", "团队", "产品", "平台", "系统", "项目", "负责人")


def extract_keywords(text: str, limit: int = 12) -> list[str]:
    tokens = [
        token for token in TOKEN_RE.findall(text or "")
        if token not in STOPWORDS and len(token) >= 2
    ]
    return [token for token, _count in Counter(tokens).most_common(limit)]


def extract_entities(text: str, limit: int = 10) -> list[dict[str, str]]:
    found: list[str] = []
    for match in _BRACKET_ENTITY_RE.finditer(text or ""):
        found.append(match.group(1).strip())
    for match in _LATIN_NAME_RE.finditer(text or ""):
        found.append(match.group(0).strip())
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for name in found:
        key = name.lower()
        if not name or key in seen:
            continue
        seen.add(key)
        entity_type = "company" if any(hint in name for hint in _ENTITY_HINTS) else "concept"
        result.append({"name": name, "type": entity_type})
        if len(result) >= limit:
            break
    return result


def judge_knowledge_type(title: str, text: str) -> str:
    title_sample = title or ""
    # 标题里的「是什么 / 定义」和「公司 / 产品」比正文里的零星词更可靠
    if any(hint in title_sample for hint in _CONCEPT_HINTS):
        return "concept"
    if any(hint in title_sample for hint in _ENTITY_HINTS):
        return "entity"

    sample = f"{title}\n{(text or '')[:2000]}"
    if any(hint in sample for hint in _DECISION_HINTS):
        return "decision"
    if any(hint in sample for hint in _CONCEPT_HINTS):
        return "concept"
    if any(hint in sample for hint in _ENTITY_HINTS):
        return "entity"
    return "note"
