"""中文友好的笔记全文检索策略。

历史问题：``search_vector`` 固定用 ``to_tsvector('simple', ...)`` 生成。``simple``
配置不做词干还原、也不切分中文（整段无空格的中文会被当作一个 lexeme），导致
GIN 索引对中文近乎无效，中文查询实际上一直退化成 ``ILIKE '%q%'`` 全表扫描。

本模块在运行时探测可用的方案并缓存结果：

1. **zhparser**（首选）：真正分词，中文召回质量最好。写入与查询都走
   ``to_tsvector('zhparser', ...)`` / ``plainto_tsquery('zhparser', ...)``。
2. **pg_trgm**（回退）：三元组相似度，对中日韩同样有效，且不需要额外词典。
   查询用 ``similarity()`` 排序 + GIN trigram 索引。
3. **ILIKE**（兜底）：上述都不可用时保留原有模糊匹配路径。

另外把「TSVECTOR 写失败就静默 pass」改成显式记录日志，避免检索索引悄悄失效。
"""
from __future__ import annotations

import logging
import re
from enum import Enum

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# 中文/CJK 字符检测：命中即认为查询需要中文友好策略
_CJK_RE = re.compile(r"[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]")

# 英文/数字词：即便在中文库里也交给 TSVECTOR 处理，精度高于三元组
_LATIN_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


class SearchStrategy(str, Enum):
    """全文检索可用方案。"""

    ZHPARSER = "zhparser"
    TRIGRAM = "trigram"
    ILIKE = "ilike"


def contains_cjk(text_value: str | None) -> bool:
    """判断查询串是否包含中日韩字符。"""
    return bool(text_value) and bool(_CJK_RE.search(text_value or ""))


def latin_tokens(query: str) -> list[str]:
    """抽取查询中的英文/数字词（用于 TSVECTOR 分支）。"""
    return _LATIN_TOKEN_RE.findall(query or "")


class SearchConfigService:
    """探测并缓存当前数据库可用的检索方案。"""

    _resolved: SearchStrategy | None = None

    @staticmethod
    async def resolve(db: AsyncSession, *, refresh: bool = False) -> SearchStrategy:
        """返回当前可用方案；探测结果在进程内缓存。"""
        if SearchConfigService._resolved is not None and not refresh:
            return SearchConfigService._resolved

        strategy = SearchStrategy.ILIKE
        try:
            rows = await db.execute(
                text("SELECT extname FROM pg_extension WHERE extname IN ('zhparser', 'pg_trgm')")
            )
            installed = {r[0] for r in rows.fetchall()}
            if "zhparser" in installed:
                strategy = SearchStrategy.ZHPARSER
            elif "pg_trgm" in installed:
                strategy = SearchStrategy.TRIGRAM
        except Exception:  # noqa: BLE001 — 探测失败不应影响检索功能
            logger.debug("检索方案探测失败，退回 ILIKE 模糊匹配", exc_info=True)
            strategy = SearchStrategy.ILIKE

        SearchConfigService._resolved = strategy
        logger.info("笔记全文检索方案：%s", strategy.value)
        return strategy

    @staticmethod
    def tsquery_config(strategy: SearchStrategy) -> str:
        """返回 ``to_tsvector`` / ``plainto_tsquery`` 应使用的配置名。"""
        return "zhparser" if strategy == SearchStrategy.ZHPARSER else "simple"

    @staticmethod
    def similarity_threshold() -> float:
        """pg_trgm 相似度阈值：低于该值不作为命中返回。

        取 0.12 是为了匹配中文短查询（如「笔记」）在三字窗口下的相似度区间，
        避免「像但不相关」的结果挤占 Top-K。
        """
        return 0.12

    @staticmethod
    def reset_cache() -> None:
        """清空探测缓存（迁移 / 测试后调用）。"""
        SearchConfigService._resolved = None