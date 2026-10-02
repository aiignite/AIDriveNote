"""笔记录音 ASR 设置服务。

提供单行配置表 ``note_asr_settings`` 的持久化、读取与运行时合并
（以数据库行覆盖环境变量默认值）。敏感字段（远程 API Key）加密落库，
只以掩码形式回传给调用方。
"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.note.asr import NoteAsrSettings
from app.services.note.recording.secret_crypto import (
    decrypt_secret,
    encrypt_secret,
    is_masked_secret_placeholder,
)

logger = logging.getLogger(__name__)


class NoteAsrSettingsService:
    """单行笔记 ASR 设置的静态服务类。

    设置表预期至多包含一条未删除记录。当记录不存在时，
    ``app.config`` 的环境变量作为默认值。
    """

    #: 可由数据库行在运行时覆盖的字段。
    _OVERRIDE_FIELDS: tuple[str, ...] = (
        "mode",
        "remote_url",
        "remote_api_key",
        "remote_timeout_seconds",
        "model",
        "language",
        "device",
        "compute_type",
        "fallback_to_local",
    )

    @staticmethod
    def _base_query() -> select:  # type: ignore[reportGeneralTypeIssues]  类型修复
        """返回过滤掉已删除行的基础查询。"""
        return select(NoteAsrSettings).where(NoteAsrSettings.is_deleted == False)  # noqa: E712

    @staticmethod
    async def get_settings(db: AsyncSession) -> NoteAsrSettings | None:
        """返回唯一未删除的设置行（若存在）。"""
        result = await db.execute(NoteAsrSettingsService._base_query())
        return result.scalar_one_or_none()

    @staticmethod
    def _env_defaults() -> dict[str, Any]:
        """从环境变量构造默认设置字典。"""
        settings = get_settings()
        return {
            "mode": (settings.NOTE_ASR_MODE or "local").strip().lower(),
            "remote_url": settings.NOTE_ASR_REMOTE_URL or None,
            "remote_api_key": settings.NOTE_ASR_REMOTE_API_KEY or None,
            "remote_timeout_seconds": max(30, int(settings.NOTE_ASR_REMOTE_TIMEOUT or 3600)),
            "model": settings.NOTE_WHISPER_MODEL or "medium",
            "language": settings.NOTE_WHISPER_LANGUAGE or "zh",
            "device": (settings.NOTE_WHISPER_DEVICE or "cpu").strip() or "cpu",
            "compute_type": (settings.NOTE_WHISPER_COMPUTE_TYPE or "int8").strip() or "int8",
            "fallback_to_local": bool(settings.NOTE_ASR_FALLBACK_LOCAL),
        }

    @staticmethod
    async def get_effective_settings(db: AsyncSession) -> dict[str, Any]:
        """返回合并后的设置（数据库值覆盖环境默认值）。

        返回的 ``remote_api_key`` 是加密存储值（或环境值）；需要明文做
        出站 HTTP 调用时请用 :meth:`decrypt_remote_api_key`。
        """
        effective = NoteAsrSettingsService._env_defaults()
        row = await NoteAsrSettingsService.get_settings(db)
        if row is None:
            return effective

        for field in NoteAsrSettingsService._OVERRIDE_FIELDS:
            value = getattr(row, field, None)
            if field == "remote_api_key":
                # 空/None 的数据库 Key 不能清空环境默认值（UI 以掩码/空值保存后常见）。
                if value is None or (isinstance(value, str) and not value.strip()):
                    continue
                effective[field] = value
                continue
            if value is not None or field == "remote_url":
                effective[field] = value
        # 即使数据库行异常也强制一个合理的最小超时。
        effective["remote_timeout_seconds"] = max(
            30, int(effective.get("remote_timeout_seconds") or 3600)
        )
        return effective

    @staticmethod
    async def save_settings(
        db: AsyncSession,
        data: dict[str, Any],
        user_name: str | None = None,
    ) -> NoteAsrSettings:
        """Upsert 单行设置。

        ``remote_api_key`` 加密落库；若传入值等于掩码占位符，则保留原 Key。
        """
        row = await NoteAsrSettingsService.get_settings(db)
        is_create = row is None
        if is_create:
            row = NoteAsrSettings()

        # 首次建行时，用当前环境值补齐缺失字段（包括前端回显的掩码 Key 占位符），
        # 让保存的行与 .env 默认值保持一致。
        env_defaults = NoteAsrSettingsService._env_defaults()

        # 把 camelCase 输入映射到 snake_case 模型字段。
        field_map: dict[str, str] = {
            "mode": "mode",
            "remoteUrl": "remote_url",
            "remoteApiKey": "remote_api_key",
            "remoteTimeoutSeconds": "remote_timeout_seconds",
            "model": "model",
            "language": "language",
            "device": "device",
            "computeType": "compute_type",
            "fallbackToLocal": "fallback_to_local",
        }
        for camel, snake in field_map.items():
            if camel not in data and snake not in data:
                continue
            value = data.get(camel, data.get(snake))
            if snake == "remote_api_key":
                if is_masked_secret_placeholder(value):
                    if is_create:
                        # 首次保存时保留环境配置的 Key。
                        value = encrypt_secret(env_defaults.get("remote_api_key"))
                    else:
                        # 保留现有的加密 Key。
                        continue
                else:
                    value = encrypt_secret(value)
            elif snake in {
                "remote_timeout_seconds",
            }:
                value = max(30, int(value)) if value is not None else 3600
            elif snake == "fallback_to_local":
                value = bool(value)
            elif snake == "mode":
                value = (value or "local").strip().lower()
            elif snake in {"model", "language", "device", "compute_type"}:
                value = (value or "").strip()
            elif snake == "remote_url":
                value = (value or "").strip() or None
            setattr(row, snake, value)

        # 归一化 mode 为受支持取值之一。
        if row.mode not in {"local", "remote"}:
            row.mode = "local"

        if is_create:
            row.created_by = user_name
            db.add(row)
        row.updated_by = user_name
        await db.commit()

        # 重新查询返回新实例。
        result = await db.execute(NoteAsrSettingsService._base_query())
        return result.scalar_one()

    @staticmethod
    def decrypt_remote_api_key(row: NoteAsrSettings | None) -> str | None:
        """返回用于出站 HTTP 调用的明文远程 API Key。"""
        if row is None:
            return None
        return decrypt_secret(row.remote_api_key)

    @staticmethod
    async def resolve_plaintext_api_key(db: AsyncSession) -> str:
        """优先使用数据库存储的 Key，回退到环境 ``NOTE_ASR_REMOTE_API_KEY``。"""
        row = await NoteAsrSettingsService.get_settings(db)
        key = NoteAsrSettingsService.decrypt_remote_api_key(row)
        if (key or "").strip():
            return str(key).strip()
        env_key = NoteAsrSettingsService._env_defaults().get("remote_api_key") or ""
        return str(env_key).strip()

    @staticmethod
    async def test_remote_connection(db: AsyncSession) -> dict[str, Any]:
        """探测已配置的远程 ASR 网关并汇报可达性。

        返回：
            ``{"reachable": bool, "detail": str}``
        """
        from app.services.note.recording.asr_remote_client import NoteAsrRemoteClient

        effective = await NoteAsrSettingsService.get_effective_settings(db)
        if effective.get("mode") != "remote":
            return {
                "reachable": False,
                "detail": "ASR mode is not remote",
            }
        url = effective.get("remote_url") or ""
        if not url.strip():
            return {
                "reachable": False,
                "detail": "remote_url is empty",
            }
        api_key = await NoteAsrSettingsService.resolve_plaintext_api_key(db)
        try:
            client = NoteAsrRemoteClient(
                url=url,
                api_key=api_key,
                timeout_seconds=int(effective.get("remote_timeout_seconds") or 3600),
            )
            ok, detail = await client.health_check_detail()
            return {
                "reachable": ok,
                "detail": detail,
            }
        except Exception as exc:  # noqa: BLE001
            logger.debug("remote ASR connection test failed: %s", exc)
            return {
                "reachable": False,
                "detail": f"remote ASR connection test failed: {exc}",
            }