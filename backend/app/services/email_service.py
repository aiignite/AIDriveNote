"""邮件发送服务 —— 笔记分享邮件与邮箱验证码邮件。

参照 AIDriveAll 的 ``email_service``（QQ SMTP + SMTP_SSL:465）实现。
正文渲染分两路：笔记邮件委托 :mod:`app.services.note.mail_render`，
验证码邮件由 :class:`EmailService.send_verification_code` 提供轻量模板。
"""
from __future__ import annotations

import asyncio
import logging
import smtplib
from email.header import Header
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

from app.config import get_settings
from app.exceptions import AppException

logger = logging.getLogger(__name__)

# 收件人地址的宽松校验：只做形状检查，避免因过严的正则误拒合法地址。
# 真正的可达性由 SMTP 服务器判定。
_ALLOWED_LOCAL_CHARS = set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+-/=?^_`{|}~"
)


def validate_recipients(raw: str) -> list[str]:
    """解析并校验收件人列表。

    支持逗号 / 分号 / 换行分隔多个地址。

    :param raw: 用户输入的收件人字符串
    :returns: 规范化后的地址列表（小写去空白）
    :raises AppException: 未填、格式非法时抛出 400
    """
    candidates = [c.strip() for c in raw.replace(";", ",").replace("\n", ",").split(",")]
    recipients: list[str] = []
    for item in candidates:
        if not item:
            continue
        _name, addr = parseaddr(item)
        addr = addr.strip()
        if not _is_valid_email(addr):
            raise AppException(f"收件人地址格式不正确：{item}", status_code=400)
        # parseaddr 可能把带显示名的地址拆开，这里只保留纯地址
        if addr not in recipients:
            recipients.append(addr)
    if not recipients:
        raise AppException("请填写收件人邮箱", status_code=400)
    return recipients


def _is_valid_email(addr: str) -> bool:
    """判断地址形状是否合法。"""
    if addr.count("@") != 1:
        return False
    local, _, domain = addr.partition("@")
    if not local or not domain:
        return False
    if any(ch not in _ALLOWED_LOCAL_CHARS for ch in local):
        return False
    # 域名需含点且不含空白
    if "." not in domain or " " in domain:
        return False
    if domain.startswith(".") or domain.endswith(".") or ".." in domain:
        return False
    return True


def _build_message(
    *,
    to_addrs: list[str],
    subject: str,
    text_body: str,
    html_body: str,
    mail_from: str,
    mail_user: str,
) -> EmailMessage:
    """组装邮件消息（纯文本 + HTML 双部件）。"""
    message = EmailMessage()
    message["From"] = mail_from or formataddr(("AIDriveNote", mail_user))
    message["To"] = ", ".join(to_addrs)
    message["Subject"] = str(Header(subject, "utf-8"))
    message.set_content(text_body, charset="utf-8")
    message.add_alternative(html_body, subtype="html", charset="utf-8")
    return message


async def _send_smtp(message: EmailMessage) -> None:
    """通过 SMTP 发送；465 端口走隐式 SSL，其余按需 starttls。"""
    settings = get_settings()

    def _sync_send() -> None:
        if settings.EMAIL_USE_SSL and settings.EMAIL_PORT == 465:
            with smtplib.SMTP_SSL(settings.EMAIL_HOST, settings.EMAIL_PORT, timeout=30) as smtp:
                smtp.login(settings.EMAIL_USER, settings.EMAIL_PASS)
                smtp.send_message(message)
            return

        with smtplib.SMTP(settings.EMAIL_HOST, settings.EMAIL_PORT, timeout=30) as smtp:
            if settings.EMAIL_USE_SSL:
                smtp.starttls()
            smtp.login(settings.EMAIL_USER, settings.EMAIL_PASS)
            smtp.send_message(message)

    await asyncio.to_thread(_sync_send)


class EmailService:
    """邮件发送：笔记分享与验证码。"""

    @staticmethod
    def is_configured() -> bool:
        """邮件是否可用（配置了发信账号，且未开启 mock）。"""
        settings = get_settings()
        if settings.EMAIL_MOCK:
            return False
        return bool(settings.EMAIL_USER and settings.EMAIL_PASS)

    @staticmethod
    async def send_email(
        *,
        to_addrs: list[str],
        subject: str,
        text_body: str,
        html_body: str,
    ) -> None:
        """发送一封邮件（通用入口）。

        :param to_addrs: 已校验的收件人地址列表
        :param subject: 邮件标题
        :param text_body: 纯文本正文
        :param html_body: HTML 正文
        :raises AppException: 未配置 SMTP / 发送失败
        """
        settings = get_settings()

        if not settings.EMAIL_USER or not settings.EMAIL_PASS:
            logger.error("邮件服务未配置，无法发送邮件 subject=%s", subject)
            raise AppException("邮件服务未配置，请联系管理员", status_code=503)

        message = _build_message(
            to_addrs=to_addrs,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
            mail_from=settings.EMAIL_FROM,
            mail_user=settings.EMAIL_USER,
        )

        try:
            await _send_smtp(message)
        except Exception as exc:  # noqa: BLE001 - 统一转成 502 对外
            logger.exception("邮件发送失败 to=%s subject=%s", to_addrs, subject)
            raise AppException("邮件发送失败，请稍后重试", status_code=502) from exc

        logger.info("邮件已发送 To=%s Subject=%s", to_addrs, subject)

    @staticmethod
    async def send_verification_code(*, email: str, code: str, ttl_minutes: int) -> None:
        """发送注册验证码邮件。

        EMAIL_MOCK 开启时不真发，仅以 WARNING 日志输出验证码，
        便于本地走通完整注册流程（从日志取码）。
        发送失败抛出 AppException，由调用方回滚事务避免残留无效验证码记录。

        :param email: 收件邮箱
        :param code: 明文验证码（仅在此处短暂使用，入库前另行哈希）
        :param ttl_minutes: 验证码有效期（分钟），用于文案
        """
        settings = get_settings()

        if settings.EMAIL_MOCK:
            logger.warning(
                "[EMAIL_MOCK] 验证码未真实发送 To=%s Code=%s（有效期 %s 分钟）",
                email, code, ttl_minutes,
            )
            return

        subject = "AIDriveNote 注册验证码"
        text_body = (
            "您好，\n\n"
            f"您正在注册 AIDriveNote 账号。验证码为：{code}\n"
            f"有效期 {ttl_minutes} 分钟，请勿泄露给他人。\n\n"
            "如非本人操作，请忽略本邮件。\n"
        )
        html_body = (
            '<div style="font-family:-apple-system,\'Segoe UI\',Arial,sans-serif;'
            'max-width:480px;margin:0 auto;padding:24px;color:#333;">'
            "<p>您好，</p>"
            "<p>您正在注册 <strong>AIDriveNote</strong> 账号，验证码为：</p>"
            '<p style="font-size:28px;font-weight:700;letter-spacing:6px;'
            'color:#ea580c;margin:16px 0;">'
            f"{code}</p>"
            f"<p>有效期 <strong>{ttl_minutes}</strong> 分钟，请勿泄露给他人。</p>"
            "<p style=\"color:#999;font-size:13px;\">如非本人操作，请忽略本邮件。</p>"
            "</div>"
        )

        await EmailService.send_email(
            to_addrs=[email],
            subject=subject,
            text_body=text_body,
            html_body=html_body,
        )

    @staticmethod
    async def send_note(
        *,
        to_raw: str,
        subject: str,
        html_body: str,
        text_body: str,
    ) -> list[str]:
        """发送一封笔记邮件。

        :param to_raw: 收件人字符串（可含多个）
        :param subject: 邮件标题
        :param html_body: HTML 正文
        :param text_body: 纯文本降级正文
        :returns: 实际收件人列表
        :raises AppException: 未配置 / 收件人非法 / 发送失败
        """
        settings = get_settings()
        recipients = validate_recipients(to_raw)

        subject = (subject or "").strip() or "AIDriveNote 笔记"

        if settings.EMAIL_MOCK:
            logger.warning(
                "[EMAIL_MOCK] 笔记邮件未真实发送 To=%s Subject=%s", recipients, subject
            )
            return recipients

        if not settings.EMAIL_USER or not settings.EMAIL_PASS:
            logger.error("邮件服务未配置，无法发送笔记邮件")
            raise AppException("邮件服务未配置，请联系管理员", status_code=503)

        message = _build_message(
            to_addrs=recipients,
            subject=subject,
            text_body=text_body,
            html_body=html_body,
            mail_from=settings.EMAIL_FROM,
            mail_user=settings.EMAIL_USER,
        )

        try:
            await _send_smtp(message)
        except Exception as exc:  # noqa: BLE001 - 统一转成 502 对外
            logger.exception("笔记邮件发送失败 to=%s", recipients)
            raise AppException("邮件发送失败，请稍后重试", status_code=502) from exc

        logger.info("笔记邮件已发送 To=%s Subject=%s", recipients, subject)
        return recipients
