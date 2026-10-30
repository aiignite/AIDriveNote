"""Generate and store note content embeddings for semantic RAG."""
from __future__ import annotations

import asyncio
import logging
import math
import os
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import AsyncSessionLocal
from app.models.note.note import Note
from app.services.note.link_parser import build_search_text

logger = logging.getLogger(__name__)

# 后台重建任务的生命周期持有：不持引用的话，事件循环只保留弱引用，任务可能被回收。
_background_tasks: set[asyncio.Task] = set()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


async def _resolve_backend() -> tuple[str, str, str, str] | None:
    """解析向量服务：(kind, base_url, api_key, model)。

    优先用「模型管理」里的模型（``EMBEDDING_MODEL_REF``）取 endpoint 与密钥，
    这样站点密钥只存数据库一份；没配引用时退回本地 Ollama。
    """
    settings = get_settings()
    provider = (settings.EMBEDDING_PROVIDER or "ollama").strip().lower()
    base_url = (settings.EMBEDDING_BASE_URL or "").strip()
    api_key = (settings.EMBEDDING_API_KEY or "").strip()
    model = (settings.EMBEDDING_MODEL or "").strip()

    if settings.EMBEDDING_MODEL_REF:
        from app.models.ai import AIModel
        from app.services.secret_crypto import decrypt_secret

        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(
                    select(AIModel).where(
                        AIModel.name == settings.EMBEDDING_MODEL_REF,
                        AIModel.is_deleted == False,  # noqa: E712
                    )
                )
            ).scalars().first()
        if row is not None:
            if not base_url and provider == "minimax":
                # MiniMax 的 Anthropic 兼容地址不能用于向量，固定官方 v1 路径
                base_url = "https://api.minimaxi.com/v1"
            base_url = base_url or (row.endpoint or "").strip()
            api_key = api_key or (decrypt_secret(row.api_key) or "").strip()
            if provider in ("", "auto"):
                provider = "openai"
            model = model or row.model_id

    if provider in ("", "auto"):
        provider = "openai" if api_key else "ollama"

    if provider in ("openai", "minimax"):
        if not (base_url and api_key and model):
            return None
        return provider, base_url, api_key, model

    return "ollama", base_url or settings.OLLAMA_BASE_URL, "", model or settings.OLLAMA_EMBED_MODEL


class EmbeddingService:
    @staticmethod
    async def effective_model_name() -> str:
        """当前生效的向量模型名（写入索引元数据，换模型时便于排查）。"""
        backend = await _resolve_backend()
        return backend[3] if backend else ""

    @staticmethod
    async def embed_text(text: str, *, purpose: str = "db") -> list[float] | None:
        vectors = await EmbeddingService.embed_texts([text], purpose=purpose)
        return vectors[0] if vectors else None

    @staticmethod
    async def embed_query(text: str) -> list[float] | None:
        """检索侧向量。MiniMax 等非对称模型要求 type=query。"""
        return await EmbeddingService.embed_text(text, purpose="query")

    @staticmethod
    async def embed_texts(
        texts: list[str], *, purpose: str = "db",
    ) -> list[list[float] | None] | None:
        """批量生成向量；失败返回 None，由调用方降级。

        批量能显著减少小模型接口的请求数（也更容易撞限流），失败会自动退避重试。
        """
        # 测试环境不访问模型服务：既避免超时拖慢单测，也保证结果可确定
        if os.getenv("AIDRIVE_TESTING") == "1":
            return None
        payloads = [(text or "").strip()[:8000] for text in texts]
        if not payloads or not any(payloads):
            return None
        backend = await _resolve_backend()
        if backend is None:
            logger.warning("Embedding backend 未配置完整，跳过向量生成")
            return None
        kind, base_url, api_key, model = backend
        url = f"{base_url.rstrip('/')}/embeddings" if kind != "ollama" else (
            f"{base_url.rstrip('/')}/api/embeddings"
        )
        for attempt in range(3):
            try:
                async with httpx.AsyncClient(timeout=60.0) as client:
                    if kind == "minimax":
                        resp = await client.post(
                            url,
                            headers={"Authorization": f"Bearer {api_key}"},
                            json={"model": model, "texts": payloads, "type": purpose},
                        )
                    elif kind == "openai":
                        resp = await client.post(
                            url,
                            headers={"Authorization": f"Bearer {api_key}"},
                            json={"model": model, "input": payloads},
                        )
                    else:
                        # Ollama 没有批量接口，逐条调用
                        resp = await client.post(
                            url,
                            json={"model": model, "prompt": payloads[0]},
                        )
                if resp.status_code == 429:
                    await asyncio.sleep(2 * (attempt + 1))
                    continue
                resp.raise_for_status()
                data = resp.json()
                if kind == "minimax":
                    vectors = data.get("vectors") or []
                elif kind == "openai":
                    rows = sorted(data.get("data") or [], key=lambda row: row.get("index", 0))
                    vectors = [row.get("embedding") for row in rows]
                else:
                    vectors = [data.get("embedding")]
                if not vectors:
                    logger.warning("Embedding 返回空向量：%s", str(data)[:200])
                    return None
                return [
                    [float(x) for x in vec] if isinstance(vec, list) and vec else None
                    for vec in vectors
                ]
            except Exception as exc:  # noqa: BLE001 — 向量服务不可用时调用方降级
                logger.warning("Embedding unavailable（第 %s 次）: %s", attempt + 1, exc)
                await asyncio.sleep(1 * (attempt + 1))
        return None

    @staticmethod
    async def update_note_embedding(db: AsyncSession, note: Note) -> bool:
        """重建笔记向量，返回是否成功。

        嵌入文本用**正文全文**（标题 + 描述 + 展开后的正文），不再用
        ``note_preview_text``——后者有描述时只返回描述，会让长笔记正文永远
        无法被语义检索命中。加密笔记跳过，避免把明文送进索引。
        """
        if note.is_encrypted:
            return False
        document_text = None
        if note.note_type == "document":
            from app.models.note.document import NoteDocument

            document_text = (
                await db.execute(
                    select(NoteDocument.extracted_text).where(
                        NoteDocument.note_id == note.id,
                    ),
                )
            ).scalar_one_or_none()
        text = build_search_text(
            note.title, note.description, note.content, note.note_type,
            document_text=document_text,
        )
        embedding = await EmbeddingService.embed_text(text[:8000])
        if not embedding:
            logger.warning("笔记语义索引更新失败（嵌入服务不可用）：note=%s", note.id)
            return False
        note.content_embedding = embedding
        return True

    @staticmethod
    async def semantic_search(
        db: AsyncSession,
        user_id: UUID,
        query: str,
        *,
        limit: int = 5,
        include_shared: bool = False,
    ) -> list[tuple[Note, float]]:
        query_emb = await EmbeddingService.embed_query(query)
        if not query_emb:
            return []

        from sqlalchemy import or_

        from app.models.note.note import NoteShare

        ownership = Note.created_by == user_id
        if include_shared:
            shared_note_ids = select(NoteShare.note_id).where(
                NoteShare.shared_with_user_id == user_id,
            )
            ownership = or_(ownership, Note.id.in_(shared_note_ids))

        result = await db.execute(
            select(Note).where(
                ownership,
                Note.is_deleted == False,  # noqa: E712
                Note.is_encrypted == False,  # noqa: E712
                Note.content_embedding.isnot(None),
            ).limit(200)
        )
        notes = list(result.scalars().all())
        scored: list[tuple[Note, float]] = []
        for note in notes:
            emb = note.content_embedding
            if isinstance(emb, list) and emb:
                sim = cosine_similarity(query_emb, [float(x) for x in emb])
                if sim > 0.1:
                    scored.append((note, sim))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:limit]


async def reindex_note(note_id: UUID) -> None:
    """在独立会话中重建单篇笔记的索引（后台任务用）。"""
    try:
        async with AsyncSessionLocal() as db:
            note = await db.get(Note, note_id)
            if not note or note.is_deleted or note.is_encrypted:
                return
            # 优先走 v2：入队后由 worker 分块建索引；v2 不可用时才更新 v1 整篇向量
            if get_settings().RAG_V2_ENABLED and note.created_by:
                from app.services.ai.rag_index_service import enqueue_note_index
                if await enqueue_note_index(db, note.id, note.created_by, reason="update"):
                    return
            await EmbeddingService.update_note_embedding(db, note)
            await db.commit()
    except Exception:  # noqa: BLE001 — 后台任务不能把异常抛回事件循环
        logger.exception("后台重建笔记向量失败：note=%s", note_id)


def schedule_note_embedding(note_id: UUID | None) -> bool:
    """把向量重建排到事件循环，不阻塞保存请求。

    返回是否成功排程。测试环境（``AIDRIVE_TESTING=1``）不排程，避免后台任务
    连到测试之外的数据库；这类场景由显式调用 ``update_note_embedding`` 覆盖。
    """
    if not note_id or os.getenv("AIDRIVE_TESTING") == "1":
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    task = loop.create_task(reindex_note(UUID(str(note_id))))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return True
