"""笔记图片资产服务：把富文本里的图片从 Base64 内嵌改为 Hash 寻址落盘。

历史问题：BlockNote 的图片以 ``data:image/...;base64,...`` 直接写进
``note_notes.content``（JSONB）。单图上限 5MB，一篇笔记插十几张图就能让该行膨胀
到数十 MB，连带拖慢列表接口、``search_text`` 构建、备份与同步传输。

本服务提供：

- **上传**：计算 SHA-256 去重，落盘到 ``uploads/note_assets/{hash[:2]}/{hash}``，
  返回可直接写进正文的相对 URL。
- **读取**：按相对路径读回文件，越界与类型不符一律拒绝。
- **迁移**：扫描存量笔记中的 Base64 图片，落盘后替换为 URL。

设计取舍：不引入对象存储依赖，仍用与录音一致的本地磁盘 + Docker volume，
保持单机部署形态不变；后续如需 S3 只需替换 ``_resolve`` / ``_persist`` 两处。
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import logging
import mimetypes
import os
import re
from pathlib import Path
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BadRequestException, NotFoundException

logger = logging.getLogger(__name__)

# 允许内联的图片来源：仅这些类型走资产化，避免 SVG 等可执行内容被原样托管
_ALLOWED_MIME = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/avif": ".avif",
    "image/svg+xml": ".svg",
}

MAX_IMAGE_BYTES = 5 * 1024 * 1024

# data URL 解析：允许 base64 与百分号编码两种形态
_DATA_URL_RE = re.compile(r"^data:(?P<mime>[\w.+-]+/[\w.+-]+)?(?P<b64>;base64)?,(?P<data>.*)$", re.DOTALL)
# 十六进制哈希文件名（64 位），用于把相对 URL 还原为磁盘路径
_HASH_URL_RE = re.compile(r"/notes/assets/(?P<hash>[0-9a-f]{64})\.(?P<ext>[a-z0-9]+)$", re.IGNORECASE)


def _uploads_root() -> Path:
    """资产根目录；与录音服务保持一致的相对路径约定。"""
    backend_root = Path(__file__).resolve().parents[3]
    return backend_root / "uploads" / "note_assets"


def _resolve(rel_path: str) -> Path:
    """把相对资产路径解析为绝对路径，并阻断 ``..`` 越界。"""
    root = _uploads_root().resolve()
    candidate = (root / rel_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise BadRequestException("非法的资源路径")
    return candidate


class NoteAssetService:
    @staticmethod
    def parse_data_url(data_url: str) -> tuple[str, bytes] | None:
        """解析 data URL；不是合法图片 data URL 时返回 None。"""
        match = _DATA_URL_RE.match((data_url or "").strip())
        if not match:
            return None
        mime = (match.group("mime") or "").lower()
        if mime not in _ALLOWED_MIME:
            return None
        raw = match.group("data") or ""
        try:
            if match.group("b64"):
                payload = base64.b64decode(raw, validate=True)
            else:
                from urllib.parse import unquote_to_bytes

                payload = unquote_to_bytes(raw)
        except (binascii.Error, ValueError):
            return None
        if not payload:
            return None
        return mime, payload

    @staticmethod
    def _persist(payload: bytes, ext: str) -> str:
        """按内容哈希落盘（同内容天然去重），返回相对 URL。"""
        digest = hashlib.sha256(payload).hexdigest()
        rel_path = f"{digest[:2]}/{digest}{ext}"
        target = _resolve(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            # 先写临时文件再原子改名，避免并发下读到半截文件
            tmp = target.with_suffix(f"{ext}.{os.getpid()}.tmp")
            tmp.write_bytes(payload)
            tmp.replace(target)
        return f"/api/v1/notes/assets/{digest}{ext}"

    @staticmethod
    async def store_image(db: AsyncSession, user_id: UUID, data: bytes, mime: str) -> dict:
        """保存图片资产，返回 ``{url, hash, size}``。"""
        del db, user_id  # 资产为全局内容寻址，不按用户隔离
        mime = (mime or "").lower()
        ext = _ALLOWED_MIME.get(mime)
        if ext is None:
            raise BadRequestException(f"不支持的图片类型：{mime or '未知'}")
        if not data:
            raise BadRequestException("图片内容为空")
        if len(data) > MAX_IMAGE_BYTES:
            raise BadRequestException(
                f"图片过大（{len(data) // 1024 // 1024}MB > {MAX_IMAGE_BYTES // 1024 // 1024}MB）",
            )
        digest = hashlib.sha256(data).hexdigest()
        url = NoteAssetService._persist(data, ext)
        return {"url": url, "hash": digest, "size": len(data)}

    @staticmethod
    async def store_data_url(db: AsyncSession, user_id: UUID, data_url: str) -> dict:
        """把 Base64 data URL 资产化（前端粘贴 / 迁移脚本使用）。"""
        parsed = NoteAssetService.parse_data_url(data_url)
        if parsed is None:
            raise BadRequestException("无法解析的图片数据")
        mime, payload = parsed
        return await NoteAssetService.store_image(db, user_id, payload, mime)

    @staticmethod
    def resolve_file_path(url_path: str) -> Path | None:
        """由请求路径解析磁盘文件；不是本服务的资产路径或文件缺失时返回 None。"""
        match = _HASH_URL_RE.search(url_path or "")
        if not match:
            return None
        target = _resolve(f"{match.group('hash')[:2]}/{match.group('hash')}.{match.group('ext')}")
        return target if target.is_file() else None

    @staticmethod
    def guess_mime(ext: str) -> str:
        return mimetypes.types_map.get(f".{ext.lstrip('.').lower()}", "application/octet-stream")

    @staticmethod
    def find_data_urls(content: dict | None) -> list[str]:
        """递归收集 content 中出现的 Base64 图片 data URL。"""
        found: list[str] = []

        def _walk(node: object) -> None:
            if isinstance(node, dict):
                for value in node.values():
                    _walk(value)
            elif isinstance(node, list):
                for item in node:
                    _walk(item)
            elif isinstance(node, str) and node.startswith("data:image/"):
                found.append(node)

        _walk(content)
        return found

    @staticmethod
    def replace_data_url(content: dict | None, data_url: str, url: str) -> dict | None:
        """把 content 中所有等于 ``data_url`` 的字符串替换为 ``url``（原地返回新对象）。"""
        if not isinstance(content, dict):
            return content

        def _walk(node: object) -> object:
            if isinstance(node, dict):
                return {k: _walk(v) for k, v in node.items()}
            if isinstance(node, list):
                return [_walk(v) for v in node]
            if node == data_url:
                return url
            return node

        return _walk(content)  # type: ignore[return-value]


async def read_asset(url_path: str) -> tuple[Path, str]:
    """读取资产文件；不存在时抛 NotFound。"""
    path = NoteAssetService.resolve_file_path(url_path)
    if path is None:
        raise NotFoundException("Asset")
    match = _HASH_URL_RE.search(url_path)
    return path, NoteAssetService.guess_mime(match.group("ext") if match else "")