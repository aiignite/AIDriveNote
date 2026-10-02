"""笔记录音文件存储辅助层。

纯文件系统层——不触碰数据库、Whisper 或后台队列。文件按
``uploads/note_recordings/{yyyy}/{mm}/{recording_id}.{ext}`` 组织，
路径相对于 ``backend/`` 根目录（与参考项目不同：
本项目 uploads 目录位于 ``backend/uploads/``，而非 ``static/uploads/``）。
"""
from __future__ import annotations

import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Final

from app.config import get_settings

# 项目根目录: backend/app/services/note/recording/audio_storage.py → 4 级回退
_BACKEND_ROOT: Final[Path] = Path(__file__).resolve().parents[4]
# 笔记录音存储根目录：backend/uploads/note_recordings
STORAGE_ROOT: Final[Path] = _BACKEND_ROOT / "uploads" / "note_recordings"

# 文件名安全化：仅保留字母/数字/点/下划线/连字符/中文
_SAFE_NAME_RE: Final[re.Pattern[str]] = re.compile(r"[^A-Za-z0-9._\-一-鿿]+")

# 支持的扩展名（白名单，防止上传到服务器后被改名为 .py 等可执行类型）
ALLOWED_EXTENSIONS: Final[frozenset[str]] = frozenset(
    {
        ".mp3",
        ".wav",
        ".m4a",
        ".aac",
        ".flac",
        ".ogg",
        ".opus",
        ".webm",
        ".mp4",
        ".mpeg",
        ".mpga",
    }
)


def _resolve_max_file_bytes() -> int:
    """从配置读取单文件大小上限，读取失败时回退到 500MB 兜底常量。"""
    default = 524_288_000  # 500MB
    try:
        value = int(get_settings().NOTE_MAX_RECORDING_BYTES)
    except Exception:  # noqa: BLE001  配置缺失/非法时不影响模块导入
        return default
    return value if value > 0 else default


# 单个录音文件大小上限（bytes）；由 NOTE_MAX_RECORDING_BYTES 驱动，兜底 500MB
MAX_FILE_BYTES: Final[int] = _resolve_max_file_bytes()


def build_storage_path(recording_id: str, file_name: str, now: datetime | None = None) -> str:
    """为一条录音构造确定性的存储路径。

    返回的是相对于 ``backend/`` 的路径（正斜杠风格），因此在 URL 与
    ``os.path.join`` 中都可直接使用。

    形如：``uploads/note_recordings/2026/10/{recording_id}.webm``。
    """
    ext = Path(file_name).suffix.lower() or ".bin"
    safe_ext = ext if ext in ALLOWED_EXTENSIONS else ".bin"

    moment = now or datetime.now(timezone.utc)
    return f"uploads/note_recordings/{moment.year:04d}/{moment.month:02d}/{recording_id}{safe_ext}"


def absolute_path(storage_path: str) -> Path:
    """将存储相对路径解析为绝对文件系统路径。"""
    return _BACKEND_ROOT / storage_path


def save_recording_file(
    file_obj: BinaryIO,
    storage_path: str,
    max_bytes: int = MAX_FILE_BYTES,
    chunk_size: int = 1024 * 1024,
) -> int:
    """流式写入文件到 ``storage_path``。

    超过 ``max_bytes`` 时抛出 ``ValueError``。返回实际写入的字节数。
    """
    target = absolute_path(storage_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    written = 0
    try:
        with target.open("wb") as out:
            while True:
                chunk = file_obj.read(chunk_size)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    # 截断已写入内容，回滚
                    out.close()
                    try:
                        target.unlink(missing_ok=True)
                    except OSError:
                        pass
                    raise ValueError(
                        f"recording file exceeds max size {max_bytes} bytes"
                    )
                out.write(chunk)
    except Exception:
        # 写失败时清理半成品
        if target.exists():
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass
        raise

    return written


def delete_recording_file(storage_path: str) -> bool:
    """删除录音文件。文件被删除时返回 True。"""
    target = absolute_path(storage_path)
    if not target.exists() or not target.is_file():
        return False
    try:
        target.unlink()
        return True
    except OSError:
        return False


def safe_filename(name: str) -> str:
    """返回上传文件名的安全版本（仅用于展示）。"""
    base = Path(name).name  # 去掉任何路径穿越部分
    cleaned = _SAFE_NAME_RE.sub("_", base).strip("._-") or "recording"
    return cleaned[:200]


def probe_audio_file(storage_path: str) -> tuple[int, str | None]:
    """尽力用 ffprobe 探测时长与格式。

    返回 ``(duration_seconds, mime_type)``。当 ffprobe 缺失或文件无法解码时
    ``duration_seconds`` 为 ``-1``。

    实现刻意保持轻量——完整探测发生在转写服务中，这里只做快速预检。
    """
    import json
    import subprocess

    target = absolute_path(storage_path)
    if not target.exists():
        return -1, None

    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration:stream=codec_name",
                "-of",
                "json",
                str(target),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return -1, None

    if result.returncode != 0:
        return -1, None

    try:
        data = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        return -1, None

    duration = -1
    fmt = data.get("format") or {}
    dur_raw = fmt.get("duration")
    if dur_raw is not None:
        try:
            duration = int(float(dur_raw))
        except (TypeError, ValueError):
            duration = -1

    mime: str | None = None
    streams = data.get("streams") or []
    if streams and isinstance(streams[0], dict):
        codec = streams[0].get("codec_name")
        if codec:
            mime = f"audio/{codec}"

    return duration, mime


def ensure_directory(storage_path: str) -> None:
    """幂等地创建存储路径的父目录。"""
    absolute_path(storage_path).parent.mkdir(parents=True, exist_ok=True)


def storage_disk_usage() -> int:
    """统计所有笔记录音占用的总字节数（尽力而为）。"""
    if not STORAGE_ROOT.exists():
        return 0
    total = 0
    for dirpath, _dirnames, filenames in os.walk(STORAGE_ROOT):
        for f in filenames:
            try:
                total += (Path(dirpath) / f).stat().st_size
            except OSError:
                continue
    return total


def move_recording_file(storage_path: str, new_storage_path: str) -> bool:
    """移动/重命名已存储文件。供重试/清理工具使用。"""
    src = absolute_path(storage_path)
    dst = absolute_path(new_storage_path)
    if not src.exists():
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dst))
        return True
    except OSError:
        return False