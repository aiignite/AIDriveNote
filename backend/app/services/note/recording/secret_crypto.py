"""敏感配置加解密工具（由参考项目的 secret_crypto_service 原样移植）。

提供基于 ``SECRET_KEY`` 派生密钥的 Fernet 对称加解密，用于 ASR 远程
网关 API Key 等敏感字段的落库加密。函数名与常量保持与参考实现一致，
以便上层服务无感知迁移。
"""
from __future__ import annotations

import base64
import hashlib
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings

# 加密值统一前缀：用于识别某字段是否已加密落库
ENCRYPTED_SECRET_PREFIX = "enc::"
# 前端回显用的掩码占位符：表示「保持原值不变」
MASKED_SECRET_PLACEHOLDER = "********"


@lru_cache(maxsize=1)
def _get_fernet() -> Fernet:
    """从 SECRET_KEY 派生 Fernet 密钥。"""
    derived_key = hashlib.sha256(get_settings().SECRET_KEY.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(derived_key))


def is_encrypted_secret(value: str | None) -> bool:
    """判断给定值是否已带有加密前缀。"""
    return bool(value and value.startswith(ENCRYPTED_SECRET_PREFIX))


def encrypt_secret(value: str | None) -> str | None:
    """加密敏感值；空值返回 None，已加密值原样返回。"""
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    if is_encrypted_secret(stripped):
        return stripped
    token = _get_fernet().encrypt(stripped.encode("utf-8")).decode("utf-8")
    return f"{ENCRYPTED_SECRET_PREFIX}{token}"


def decrypt_secret(value: str | None) -> str | None:
    """解密敏感值；非加密值原样返回，解密失败返回 None。"""
    if value is None:
        return None
    if not is_encrypted_secret(value):
        return value
    token = value.removeprefix(ENCRYPTED_SECRET_PREFIX).encode("utf-8")
    try:
        return _get_fernet().decrypt(token).decode("utf-8")
    except InvalidToken:
        return None


def mask_secret(value: str | None) -> str | None:
    """返回掩码占位符（仅当值可解密为非空时）。"""
    return MASKED_SECRET_PLACEHOLDER if decrypt_secret(value) else None


def is_masked_secret_placeholder(value: str | None) -> bool:
    """判断值是否为前端回显的掩码占位符。"""
    return bool(value and value.strip() == MASKED_SECRET_PLACEHOLDER)