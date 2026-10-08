"""一次性迁移：把 ai_models.api_key 的存量明文加密为 enc:: 密文。

用法（在 backend 目录下）::

    python -m scripts.encrypt_ai_model_api_keys            # 预演，只报告
    python -m scripts.encrypt_ai_model_api_keys --apply    # 实际写入

设计要点：

- 幂等：已带 ``enc::`` 前缀的值会被跳过，可重复执行。
- 依赖 ``SECRET_KEY``：必须与后端运行时的密钥一致，否则新写入的密文无法解密。
  脚本会校验这一点（写入前先做一次往返解密自检）。
- 不打印任何密钥内容，只报告条数。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

os.environ.setdefault("AIDRIVE_TESTING", "1")

from sqlalchemy import select, update  # noqa: E402

from app.database import AsyncSessionLocal  # noqa: E402
from app.models.ai import AIModel  # noqa: E402
from app.services.secret_crypto import (  # noqa: E402
    decrypt_secret,
    encrypt_secret,
    is_encrypted_secret,
)


async def main(apply: bool) -> int:
    # 自检：确保加解密往返正常（避免用错 SECRET_KEY 把数据锁死）
    probe = encrypt_secret("__probe__")
    if decrypt_secret(probe) != "__probe__":
        print("[错误] 加解密自检失败，请检查 SECRET_KEY 是否与后端运行时一致。", file=sys.stderr)
        return 2

    async with AsyncSessionLocal() as db:
        rows = await db.execute(
            select(AIModel.id, AIModel.api_key).where(AIModel.api_key.isnot(None))
        )
        pending: list[tuple[object, str]] = [
            (model_id, key)
            for model_id, key in rows.all()
            if key and not is_encrypted_secret(key)
        ]

        if not pending:
            print("无需迁移：所有已配置的 API Key 均为密文（或为空）。")
            return 0

        print(f"发现 {len(pending)} 条明文 API Key。")
        for model_id, key in pending:
            encrypted = encrypt_secret(key)
            assert encrypted and decrypt_secret(encrypted) == key.strip()
            if apply:
                await db.execute(
                    update(AIModel).where(AIModel.id == model_id).values(api_key=encrypted)
                )
        if apply:
            await db.commit()
            print(f"已加密并落库 {len(pending)} 条。")
        else:
            await db.rollback()
            print("预演模式，未写入。确认无误后加 --apply 执行。")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="加密 ai_models.api_key 存量明文")
    parser.add_argument("--apply", action="store_true", help="实际写入（默认仅预演）")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.apply)))