"""音频直链签名模块。

``<audio src>`` 标签无法携带 Authorization 请求头，因此用确定性的 HMAC
签名让音频流可直接播放：前端拿到带 ``?s=<sig>`` 的地址即可播放，
后端校验签名时无需额外会话。

签名密钥来源于 ``app.config.get_settings().SECRET_KEY``；
签名算法为 HMAC-SHA256，消息前缀固定为 ``note-rec-audio:``。
"""
from __future__ import annotations

import hashlib
import hmac

from app.config import get_settings

# 签名消息前缀，避免与其他业务复用 SECRET_KEY 时产生签名碰撞
_SIGN_PREFIX = "note-rec-audio:"


def _signing_key() -> bytes:
    """返回用于 HMAC 的密钥字节串（源自 SECRET_KEY）。"""
    return get_settings().SECRET_KEY.encode("utf-8")


def build_audio_signature(recording_id: str) -> str:
    """为录音 id 生成确定性的 HMAC 十六进制签名。"""
    message = f"{_SIGN_PREFIX}{recording_id}".encode()
    return hmac.new(_signing_key(), message, hashlib.sha256).hexdigest()


def verify_audio_signature(recording_id: str, signature: str | None) -> bool:
    """校验录音签名是否有效。

    使用 ``hmac.compare_digest`` 做恒定时间比对；签名参数为空时直接返回 False。
    """
    if not signature:
        return False
    expected = build_audio_signature(recording_id)
    return hmac.compare_digest(expected, signature)


def build_audio_url(recording_id: str, api_prefix: str = "/api/v1") -> str:
    """构造可直接播放的音频直链（带签名查询参数）。"""
    sig = build_audio_signature(recording_id)
    return f"{api_prefix}/note-recordings/{recording_id}/audio?s={sig}"