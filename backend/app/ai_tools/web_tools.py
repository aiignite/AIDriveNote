"""Web tools — AI 助手联网搜索（免 Key 网页抓取）。

实现说明：
- 不引入任何第三方解析依赖（无 BeautifulSoup / lxml），仅使用标准库 ``html.parser``
  解析 Bing 搜索结果页；
- 使用 httpx 发起请求，超时与结果条数由 ``app.config`` 中的
  ``AI_WEB_SEARCH_*`` 配置控制；
- 默认关闭，需在服务端 .env 设置 ``AI_WEB_SEARCH_ENABLED=true`` 后重启才会真正联网；
- 工具注册到 ``note`` 分类，随「笔记助手」的工具白名单自动下发，无需数据库迁移。
"""
from __future__ import annotations

import base64
import logging
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from uuid import UUID

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai_tools.registry import ToolRegistry
from app.config import get_settings

logger = logging.getLogger(__name__)

CATEGORY = "note"

# 搜索入口（国内可直连的 Bing 站点）
SEARCH_ENDPOINT = "https://cn.bing.com/search"

# 请求头：使用常见桌面浏览器 UA，避免被站点判定为爬虫而返回空页
REQUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# 单条结果摘要的最大字符数，避免占用过多模型上下文
MAX_SNIPPET_CHARS = 400


def _decode_bing_u(raw: str) -> str:
    """解码 Bing ``/ck/a`` 跳转链接里的 ``u`` 参数（形如 ``a1<base64url>``）。

    @param raw 原始 u 参数值
    @returns 解码后的真实 URL；解码失败时回退为 URL 解码结果
    """
    if not raw:
        return ""
    token = raw[2:] if raw.startswith("a1") else raw
    padding = "=" * (-len(token) % 4)
    try:
        return base64.urlsafe_b64decode(token + padding).decode("utf-8", "ignore")
    except Exception:  # noqa: BLE001 — 解码失败不影响主流程，回退即可
        return unquote(raw)


def _normalize_url(href: str) -> str:
    """规范化结果链接：展开 Bing 跳转包装，丢掉无协议的空链接。

    @param href 原始 href
    @returns 规范化后的 URL（无效时返回空串）
    """
    if not href:
        return ""
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if parsed.netloc.endswith("bing.com") and parsed.path.startswith("/ck/a"):
        params = parse_qs(parsed.query)
        decoded = _decode_bing_u((params.get("u") or [""])[0])
        if decoded:
            return decoded
    if not parsed.scheme:
        return ""
    return href


class _BingResultParser(HTMLParser):
    """从 Bing 搜索结果 HTML 中提取 ``{title, url, snippet}`` 列表。"""

    def __init__(self) -> None:
        """初始化解析器与内部状态。"""
        super().__init__(convert_charrefs=True)
        # 解析出的结果列表
        self.results: list[dict[str, str]] = []
        # 是否位于某条搜索结果（li.b_algo）内部
        self._in_result = False
        # 是否位于标题 h2 内
        self._in_h2 = False
        # 是否位于标题链接 a 内
        self._in_anchor = False
        # 是否位于摘要 p 内
        self._in_snippet = False
        # 当前结果的链接
        self._href = ""
        # 当前结果的标题文本片段
        self._title_parts: list[str] = []
        # 当前结果的摘要文本片段
        self._snippet_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        """处理开始标签，识别结果容器 / 标题 / 摘要结构。"""
        attrs_dict = dict(attrs)
        if tag == "li":
            if "b_algo" in (attrs_dict.get("class") or ""):
                self._in_result = True
                self._href = ""
                self._title_parts = []
                self._snippet_parts = []
        elif self._in_result and tag == "h2":
            self._in_h2 = True
        elif self._in_result and tag == "a" and self._in_h2:
            self._in_anchor = True
            self._href = attrs_dict.get("href") or self._href
        elif self._in_result and tag == "p":
            self._in_snippet = True

    def handle_endtag(self, tag: str) -> None:
        """处理结束标签，在结果容器闭合时落盘一条结果。"""
        if tag == "a":
            self._in_anchor = False
        elif tag == "h2":
            self._in_h2 = False
        elif tag == "p":
            self._in_snippet = False
        elif tag == "li" and self._in_result:
            self._flush()

    def handle_data(self, data: str) -> None:
        """收集标题与摘要文本。"""
        if not self._in_result:
            return
        if self._in_anchor:
            self._title_parts.append(data)
        elif self._in_snippet:
            self._snippet_parts.append(data)

    def _flush(self) -> None:
        """把当前累积的标题 / 链接 / 摘要写入 results 并重置状态。"""
        self._in_result = False
        self._in_anchor = False
        self._in_h2 = False
        self._in_snippet = False
        title = " ".join("".join(self._title_parts).split())
        snippet = " ".join("".join(self._snippet_parts).split())
        url = _normalize_url(self._href)
        if title and url:
            self.results.append({
                "title": title,
                "url": url,
                "snippet": snippet[:MAX_SNIPPET_CHARS],
            })
        self._title_parts = []
        self._snippet_parts = []
        self._href = ""


async def _web_search(
    db: AsyncSession,
    user_id: UUID,
    query: str,
    max_results: int | None = None,
) -> dict[str, Any]:
    """联网搜索工具处理函数：抓取 Bing 结果页并抽取标题 / 链接 / 摘要。

    @param db 数据库会话（本工具不使用，仅为统一签名）
    @param user_id 当前用户 id（本工具不使用，仅为统一签名）
    @param query 搜索关键词或问题
    @param max_results 返回条数上限，缺省取服务端配置
    @returns 统一的工具执行结果字典
    """
    settings = get_settings()
    if not settings.AI_WEB_SEARCH_ENABLED:
        return {
            "success": False,
            "error": "联网搜索未启用，请在服务端 .env 设置 AI_WEB_SEARCH_ENABLED=true 后重启服务",
        }

    keyword = (query or "").strip()
    if not keyword:
        return {"success": False, "error": "搜索关键词不能为空"}

    limit = max_results if isinstance(max_results, int) and max_results > 0 else settings.AI_WEB_SEARCH_MAX_RESULTS
    limit = min(limit, 10)

    try:
        async with httpx.AsyncClient(
            timeout=settings.AI_WEB_SEARCH_TIMEOUT,
            follow_redirects=True,
            headers=REQUEST_HEADERS,
        ) as client:
            resp = await client.get(SEARCH_ENDPOINT, params={"q": keyword})
            resp.raise_for_status()
            html = resp.text
    except Exception as exc:  # noqa: BLE001 — 网络异常统一转为可读错误返回给模型
        logger.warning("web_search 请求失败: %s", exc)
        return {"success": False, "error": f"联网搜索请求失败：{exc}"}

    parser = _BingResultParser()
    try:
        parser.feed(html)
    except Exception:  # noqa: BLE001 — 解析异常不应中断对话
        logger.exception("web_search 解析失败")

    results = parser.results[:limit]
    if not results:
        return {"success": False, "error": "未从搜索结果中解析到内容，请更换关键词后重试"}

    return {
        "success": True,
        "query": keyword,
        "count": len(results),
        "results": results,
        "message": f"已检索到 {len(results)} 条与“{keyword}”相关的结果，请结合问题作答并附上来源链接",
    }


def _register_all() -> None:
    """向工具注册表注册联网搜索工具。"""
    ToolRegistry.register("web_search", {
        "name": "web_search",
        "description": (
            "联网搜索互联网公开信息，返回若干条 {title, url, snippet} 结果。"
            "适用于查询实时/最新资讯、事实核查、外部资料检索。"
            "拿到结果后应结合用户问题用中文作答，并附上关键来源链接；"
            "不要原样堆砌搜索结果。"
        ),
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "搜索关键词或问题"},
            "max_results": {"type": "integer", "description": "返回条数上限，默认取服务端配置（通常 5）"},
        }, "required": ["query"]},
    }, _web_search, CATEGORY, "联网搜索")


_register_all()