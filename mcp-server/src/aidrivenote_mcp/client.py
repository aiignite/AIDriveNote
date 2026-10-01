"""AIDriveNote REST API 客户端封装。"""
from __future__ import annotations

from typing import Any

import httpx

from .config import Settings


class ApiError(RuntimeError):
    """调用后端 API 失败；message 已是可直接展示给使用者的中文文案。"""


class AIDriveNoteClient:
    """对 AIDriveNote 后端 REST API 的轻量封装。

    统一注入 Bearer 令牌；写操作不重试，避免重复创建笔记。
    路径均不以斜杠开头，配合构造时补全的 base_url 结尾斜杠保证拼接正确。
    """

    def __init__(self, settings: Settings) -> None:
        """创建客户端。

        @param settings 运行期配置
        """
        self._settings = settings
        self._client = httpx.AsyncClient(
            # 结尾斜杠是 httpx 路径拼接正确的前提
            base_url=f"{settings.base_url}/",
            timeout=settings.timeout,
            headers={
                "Authorization": f"Bearer {settings.api_token}",
                "Content-Type": "application/json",
            },
        )

    async def __aenter__(self) -> "AIDriveNoteClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        """释放底层连接池。"""
        await self._client.aclose()

    @staticmethod
    def _extract_error(response: httpx.Response) -> str:
        """从错误响应中提取可读信息。

        @param response 错误响应
        @returns 中文错误文案
        """
        try:
            detail: Any = response.json().get("detail")
        except Exception:  # noqa: BLE001 — 非 JSON 响应退化为纯文本
            detail = response.text
        if isinstance(detail, list):
            # FastAPI 校验错误是列表结构，拼成一行便于阅读
            detail = "; ".join(
                f"{'.'.join(str(x) for x in item.get('loc', []))}: {item.get('msg')}"
                if isinstance(item, dict)
                else str(item)
                for item in detail
            )
        return f"接口调用失败（HTTP {response.status_code}）：{detail}"

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        retry: bool = False,
    ) -> Any:
        """发起请求并统一转换错误。

        @param method HTTP 方法
        @param path 相对路径（不以斜杠开头）
        @param json 请求体
        @param params 查询参数
        @param retry 是否重试一次（仅用于幂等的 GET）
        @returns 解析后的 JSON；204 或无内容返回 None
        """
        attempts = 2 if retry else 1
        last_error: Exception | None = None
        for _ in range(attempts):
            try:
                response = await self._client.request(method, path, json=json, params=params)
            except httpx.HTTPError as exc:
                last_error = exc
                continue

            if response.status_code == 401:
                raise ApiError(
                    "令牌无效或已撤销，请到笔记「设置 → 访问令牌」重新生成后更新 MCP 配置。"
                )
            if response.status_code >= 400:
                raise ApiError(self._extract_error(response))
            if response.status_code == 204 or not response.content:
                return None
            return response.json()

        raise ApiError(
            f"无法连接 {self._settings.base_url}，请检查地址与网络。原始错误: {last_error}"
        )

    # ── 笔记 ──────────────────────────────────────────────

    async def create_note(self, payload: dict[str, Any]) -> dict[str, Any]:
        """创建笔记。

        @param payload 笔记字段（title / note_type / content / folder_id / description）
        @returns 新建笔记对象
        """
        return await self._request("POST", "notes", json=payload)

    async def get_note(self, note_id: str) -> dict[str, Any]:
        """按 ID 获取笔记详情。

        @param note_id 笔记 ID
        @returns 笔记对象
        """
        return await self._request("GET", f"notes/{note_id}", retry=True)

    async def append_note(self, note_id: str, text: str) -> dict[str, Any]:
        """向笔记末尾追加内容。

        @param note_id 笔记 ID
        @param text 追加文本
        @returns 更新后的笔记对象
        """
        return await self._request("POST", f"notes/{note_id}/append", json={"text": text})

    async def list_notes(self, *, search: str | None = None, limit: int = 20) -> dict[str, Any]:
        """列出 / 搜索笔记（不含正文）。

        @param search 关键词，可匹配标题
        @param limit 返回条数上限
        @returns {items, total}
        """
        params: dict[str, Any] = {"limit": limit}
        if search:
            params["search"] = search
        return await self._request("GET", "notes", params=params, retry=True)

    async def search_notes(self, query: str, limit: int = 10) -> dict[str, Any]:
        """全文检索笔记。

        @param query 检索词
        @param limit 返回条数上限
        @returns {items, total, highlights}
        """
        return await self._request(
            "GET",
            "notes/search/fulltext",
            params={"q": query, "limit": limit},
            retry=True,
        )

    # ── 文件夹与标签 ──────────────────────────────────────

    async def list_folders(self) -> list[dict[str, Any]]:
        """列出全部文件夹（扁平结构，含 parent_id）。

        @returns 文件夹列表
        """
        return await self._request("GET", "notes/folders/list", retry=True)

    async def list_tags(self) -> list[dict[str, Any]]:
        """列出全部标签。

        @returns 标签列表
        """
        return await self._request("GET", "notes/tags/list", retry=True)

    async def create_tag(self, name: str, color: str = "#6b7280") -> dict[str, Any]:
        """创建标签。

        @param name 标签名
        @param color 标签颜色
        @returns 标签对象
        """
        return await self._request("POST", "notes/tags", json={"name": name, "color": color})

    async def add_tag_to_note(self, note_id: str, tag_id: str) -> None:
        """把标签挂到笔记上。

        @param note_id 笔记 ID
        @param tag_id 标签 ID
        """
        await self._request("POST", f"notes/{note_id}/tags/{tag_id}")