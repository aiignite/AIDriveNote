"""蒸馏结果的内部类型与 LLM 输出校验模型。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

KnowledgeType = Literal["concept", "entity", "topic", "decision", "note"]


class LLMEntity(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    type: str = Field(default="concept", max_length=20)


class LLMClaim(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    source_excerpt: str = Field(default="", max_length=800)


class LLMCard(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    knowledge_type: KnowledgeType = "note"
    summary: str = Field(min_length=1, max_length=1200)
    key_points: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    entities: list[LLMEntity] = Field(default_factory=list)
    topic: str = Field(default="", max_length=100)
    tags: list[str] = Field(default_factory=list)
    claims: list[LLMClaim] = Field(default_factory=list)
    confidence: Literal["high", "medium", "low"] = "medium"

    @field_validator("key_points", "keywords", "tags", mode="before")
    @classmethod
    def _coerce_str_list(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [value]
        if not isinstance(value, list):
            return []
        return [str(item).strip() for item in value if str(item).strip()]


class LLMResult(BaseModel):
    cards: list[LLMCard] = Field(default_factory=list)


@dataclass
class CardDraft:
    title: str
    knowledge_type: KnowledgeType
    summary: str
    confidence: str = "medium"
    payload: dict[str, Any] = field(default_factory=dict)
    extractor: str = "rule"
    model: str | None = None
    prompt_version: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    merge_target_note_id: uuid.UUID | None = None
    merge_score: float | None = None
