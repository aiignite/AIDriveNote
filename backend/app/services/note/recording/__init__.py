"""笔记录音服务包。

提供录音文件存储、HMAC 音频直链签名、语音转写、ASR 设置、
常用词库与转写润色等能力。这些服务刻意与路由层、DB 会话解耦；
路由层注入 ``AsyncSession`` 并显式传入。
"""

from .audio_storage import (
    ALLOWED_EXTENSIONS,
    MAX_FILE_BYTES,
    absolute_path,
    build_storage_path,
    delete_recording_file,
    safe_filename,
    save_recording_file,
    storage_disk_usage,
)
from .asr_settings_service import NoteAsrSettingsService
from .common_term_service import NoteCommonTermService
from .recording_service import NoteRecordingService
from .signing import (
    build_audio_signature,
    build_audio_url,
    verify_audio_signature,
)
from .transcription_service import NoteTranscriptionService

__all__ = [
    # 文件存储
    "ALLOWED_EXTENSIONS",
    "MAX_FILE_BYTES",
    "absolute_path",
    "build_storage_path",
    "delete_recording_file",
    "save_recording_file",
    "safe_filename",
    "storage_disk_usage",
    # 音频直链签名
    "build_audio_signature",
    "build_audio_url",
    "verify_audio_signature",
    # 服务类
    "NoteAsrSettingsService",
    "NoteCommonTermService",
    "NoteRecordingService",
    "NoteTranscriptionService",
]