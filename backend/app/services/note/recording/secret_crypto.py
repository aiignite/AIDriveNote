"""敏感配置加解密工具（兼容入口）。

实现已提升为通用模块 :mod:`app.services.secret_crypto`（原先只服务 ASR，
现在同时服务 AI 模型 Provider API Key）。本模块仅做再导出，保证既有调用方
（``asr_settings_service`` / ``transcription_service``）无需修改 import。
"""
from __future__ import annotations

from app.services.secret_crypto import (  # noqa: F401 — 兼容再导出
    ENCRYPTED_SECRET_PREFIX,
    MASKED_SECRET_PLACEHOLDER,
    decrypt_secret,
    encrypt_secret,
    is_encrypted_secret,
    is_masked_secret_placeholder,
    mask_secret,
)

__all__ = [
    "ENCRYPTED_SECRET_PREFIX",
    "MASKED_SECRET_PLACEHOLDER",
    "decrypt_secret",
    "encrypt_secret",
    "is_encrypted_secret",
    "is_masked_secret_placeholder",
    "mask_secret",
]