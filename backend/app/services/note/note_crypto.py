"""笔记加密工具。

为「加密文档 / 加密文件夹」提供基于用户密码的对称加解密能力：

- 用 ``PBKDF2-HMAC-SHA256`` 从「密码 + 随机盐」派生 Fernet 密钥；
- 正文以 ``{"__enc__": "<token>"}`` 形式落库，未加密内容保持原样，读取时按前缀识别；
- 密码本身不落库，只保存 bcrypt 校验器（``enc_verifier``）与盐（``enc_salt``）；
- 解锁票据（unlock token）用 ``SECRET_KEY`` 派生的 Fernet 二次加密，票据内携带本次
  派生出的密钥，服务端凭票据在会话内直接加解密，无需反复索要密码。

与通用落库加密 ``app.services.secret_crypto`` 相互独立：后者用全局 ``SECRET_KEY``
加密敏感配置，前者用**用户密码**加密笔记正文。
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from app.config import get_settings

# 正文密文的统一标记键：content 顶层出现该键即视为密文
ENCRYPTED_CONTENT_KEY = "__enc__"
# PBKDF2 迭代次数：兼顾安全与移动端/服务端解密耗时
KDF_ITERATIONS = 200_000
# 解锁票据默认有效期（秒），与登录会话对齐（12 小时）
UNLOCK_TOKEN_TTL = 12 * 60 * 60
# 解锁票据用途标记，避免与其它 Fernet 密文混用
_UNLOCK_TOKEN_MARK = "note_unlock"


def new_salt() -> str:
    """生成 16 字节随机盐并以 base64 返回。"""
    return base64.b64encode(os.urandom(16)).decode("ascii")


def derive_fernet_key(password: str, salt_b64: str) -> str:
    """由密码与盐派生 Fernet 密钥（base64url 文本）。

    @param password 用户设置的明文密码
    @param salt_b64 base64 编码的盐（由 ``new_salt`` 生成）
    @returns 可直接交给 Fernet 使用的密钥字符串
    """
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=base64.b64decode(salt_b64),
        iterations=KDF_ITERATIONS,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode("utf-8"))).decode("ascii")


def is_encrypted_content(content: dict | None) -> bool:
    """判断 content 是否为加密密文（含统一前缀键）。"""
    return isinstance(content, dict) and ENCRYPTED_CONTENT_KEY in content


def encrypt_content(content: dict | None, key: str) -> dict:
    """把明文 content 加密为 ``{"__enc__": token}``。

    已是密文时原样返回（幂等）。``content`` 为空时仍产出密文，
    以保持「已加密」语义一致。

    @param content 明文正文（JSON 可序列化）
    @param key ``derive_fernet_key`` 派生的 Fernet 密钥
    @returns 密文包裹对象
    """
    if is_encrypted_content(content):
        return content  # type: ignore[return-value]
    raw = json.dumps(content if content is not None else {}, ensure_ascii=False).encode("utf-8")
    token = Fernet(key.encode("ascii")).encrypt(raw).decode("ascii")
    return {ENCRYPTED_CONTENT_KEY: token}


def decrypt_content(stored: dict | None, key: str) -> dict | None:
    """把密文 content 解密为明文；非密文原样返回，解密失败返回 None。

    @param stored 存储中的 content（可能是密文或明文）
    @param key ``derive_fernet_key`` 派生的 Fernet 密钥
    @returns 明文正文；密钥错误 / 数据损坏时返回 None
    """
    if not is_encrypted_content(stored):
        return stored
    token = str(stored[ENCRYPTED_CONTENT_KEY]).encode("ascii")
    try:
        raw = Fernet(key.encode("ascii")).decrypt(token).decode("utf-8")
    except (InvalidToken, ValueError):
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


@lru_cache(maxsize=1)
def _get_token_fernet() -> Fernet:
    """从 SECRET_KEY 派生「解锁票据」专用 Fernet 密钥。"""
    derived = hashlib.sha256(get_settings().SECRET_KEY.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(derived))


def make_unlock_token(
    *,
    scope: str,
    target_id: str,
    user_id: str,
    key_b64: str,
    ttl: int = UNLOCK_TOKEN_TTL,
) -> str:
    """构造解锁票据。

    票据内携带本次派生出的 Fernet 密钥，因此服务端在有效期内无需密码即可
    对同一对象加解密。

    @param scope 保护范围，``note`` 或 ``folder``
    @param target_id 笔记 / 文件夹 ID
    @param user_id 票据归属用户 ID
    @param key_b64 该对象的内容加密密钥
    @param ttl 有效期（秒）
    @returns 加密后的票据字符串
    """
    payload = {
        "mark": _UNLOCK_TOKEN_MARK,
        "uid": str(user_id),
        "scope": scope,
        "id": str(target_id),
        "key": key_b64,
        "exp": int(time.time()) + ttl,
    }
    return _get_token_fernet().encrypt(json.dumps(payload).encode("utf-8")).decode("ascii")


def parse_unlock_token(token: str | None) -> dict | None:
    """解析并校验解锁票据；无效 / 过期返回 None。

    @param token 前端通过 ``X-Note-Unlock`` 头传入的票据
    @returns 票据 payload（含 uid / scope / id / key / exp）或 None
    """
    if not token:
        return None
    try:
        raw = _get_token_fernet().decrypt(token.encode("ascii")).decode("utf-8")
        payload = json.loads(raw)
    except (InvalidToken, ValueError, json.JSONDecodeError):
        return None
    if payload.get("mark") != _UNLOCK_TOKEN_MARK:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload
