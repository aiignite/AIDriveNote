"""一次性迁移：把笔记正文里的 Base64 内嵌图片替换为服务端资产 URL。

用法（在 backend 目录下）::

    python -m scripts.migrate_note_base64_images            # 预演，只报告
    python -m scripts.migrate_note_base64_images --apply    # 实际写入

背景：BlockNote 曾把粘贴的图片以 ``data:image/...;base64,...`` 直接写进
``note_notes.content``（JSONB），单图 5MB，一篇笔记可达数十 MB。此脚本扫描存量
笔记，把每个 Base64 图片落盘为 Hash 寻址资产并把正文替换成 URL。

要点：

- **幂等**：只处理含 ``data:image/`` 的内容；已资产化的笔记不会重复处理。
- **内容寻址**：同一张图在多篇笔记里只落一份磁盘文件。
- **逐条提交**：单条笔记失败不影响其余，最后统一汇总报告。
- 同步渲染旧链接不需要改：正文里已是 URL 的历史记录天然兼容。
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

os.environ.setdefault("AIDRIVE_TESTING", "1")

from sqlalchemy import select  # noqa: E402

from app.database import AsyncSessionLocal  # noqa: E402
from app.models.note.note import Note  # noqa: E402
from app.services.note.note_asset_service import NoteAssetService  # noqa: E402


async def main(apply: bool) -> int:
    async with AsyncSessionLocal() as db:
        notes = list(
            (
                await db.execute(
                    select(Note.id, Note.title, Note.content).where(
                        Note.note_type == "rich_text",
                        Note.is_deleted == False,  # noqa: E712
                    )
                )
            ).all()
        )

        touched = 0
        images = 0
        failed = 0
        for note_id, title, content in notes:
            if not content:
                continue
            data_urls = NoteAssetService.find_data_urls(content)
            if not data_urls:
                continue

            new_content = content
            replaced = 0
            for data_url in data_urls:
                try:
                    asset = await NoteAssetService.store_data_url(db, None, data_url)
                except Exception as exc:  # noqa: BLE001 — 单张失败不应中断整批
                    print(f"  [跳过] 笔记 {title!r} 的某张图片处理失败：{exc}", file=sys.stderr)
                    failed += 1
                    continue
                new_content = NoteAssetService.replace_data_url(
                    new_content, data_url, asset["url"],
                )
                replaced += 1

            if replaced == 0:
                continue
            touched += 1
            images += replaced
            note = await db.get(Note, note_id)
            if note is not None:
                note.content = new_content
                if apply:
                    await db.commit()
                else:
                    await db.rollback()

    verb = "已迁移" if apply else "预演：将迁移"
    print(f"{verb} {touched} 篇笔记、共 {images} 张图片（失败 {failed} 张）。")
    if not apply:
        print("预演模式，未写入。确认无误后加 --apply 执行。")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="把笔记中的 Base64 内嵌图片迁移为资产 URL")
    parser.add_argument("--apply", action="store_true", help="实际写入（默认仅预演）")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.apply)))