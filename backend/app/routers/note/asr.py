"""笔记语音转写（ASR）设置与常用词库路由。

    GET    /note-asr/settings                 读取生效设置（所有登录用户）
    PUT    /note-asr/settings                 保存设置（仅 admin）
    POST   /note-asr/settings/test-remote     测试远程网关连通性（仅 admin）
    GET    /note-asr/common-terms             列举常用词
    POST   /note-asr/common-terms             新建常用词
    PATCH  /note-asr/common-terms/{id}        更新常用词
    DELETE /note-asr/common-terms/{id}        软删除常用词

设置表为全局单行；读取时数据库行覆盖环境变量默认值，远程 API Key 只回传掩码。
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_admin, get_current_user
from app.database import get_db
from app.exceptions import NotFoundException
from app.models.note.asr import NoteAsrSettings, NoteCommonTerm
from app.models.user import User
from app.services.note.recording import (
    NoteAsrSettingsService,
    NoteCommonTermService,
)
from app.services.note.recording.secret_crypto import MASKED_SECRET_PLACEHOLDER

router = APIRouter(prefix="/note-asr", tags=["Note ASR"])


# ── 请求 / 响应模型 ───────────────────────────────────────────────────

class AsrSettingsUpdate(BaseModel):
    """ASR 设置更新载荷（字段全部可选，仅更新传入项）。"""

    # 运行模式：local（本机 faster-whisper）/ remote（局域网 GPU 网关）
    mode: str | None = None
    # 远程 ASR 网关地址
    remote_url: str | None = None
    # 远程网关 API Key；传掩码 "********" 表示保持原值不变
    remote_api_key: str | None = None
    # 远程请求最大等待秒数
    remote_timeout_seconds: int | None = Field(default=None, ge=30)
    # Whisper 模型规格
    model: str | None = None
    # 识别语言代码，空串表示自动检测
    language: str | None = None
    # 本机计算设备：cpu / cuda
    device: str | None = None
    # 本机量化精度：int8 / float16 等
    compute_type: str | None = None
    # 远程失败时是否降级到本机
    fallback_to_local: bool | None = None


class CommonTermCreate(BaseModel):
    """常用词新建载荷。"""

    # 正确写法词条
    term: str
    # 同音 / 易错写法，逗号分隔
    alias: str | None = None
    # 备注
    remark: str | None = None
    # 是否启用
    is_enabled: bool = True


class CommonTermUpdate(BaseModel):
    """常用词更新载荷（字段全部可选）。"""

    term: str | None = None
    alias: str | None = None
    remark: str | None = None
    is_enabled: bool | None = None
    usage_count: int | None = None


# ── 序列化辅助 ────────────────────────────────────────────────────────

def _to_common_term_out(term: NoteCommonTerm) -> dict[str, Any]:
    """把常用词 ORM 对象序列化为响应字典。"""
    return {
        "id": str(term.id),
        "term": term.term,
        "alias": term.alias,
        "remark": term.remark,
        "is_enabled": term.is_enabled,
        "usage_count": term.usage_count,
        "created_at": term.created_at,
        "created_by": term.created_by,
    }


async def _build_settings_out(db: AsyncSession) -> dict[str, Any]:
    """构造 ASR 设置响应：数据库行覆盖环境默认值，Key 以掩码回传。"""
    effective = await NoteAsrSettingsService.get_effective_settings(db)
    row: NoteAsrSettings | None = await NoteAsrSettingsService.get_settings(db)
    return {
        "mode": effective.get("mode") or "local",
        "remote_url": effective.get("remote_url"),
        "remote_api_key": (
            MASKED_SECRET_PLACEHOLDER if effective.get("remote_api_key") else None
        ),
        "remote_timeout_seconds": int(effective.get("remote_timeout_seconds") or 3600),
        "model": effective.get("model") or "medium",
        "language": effective.get("language") or "zh",
        "device": effective.get("device") or "cpu",
        "compute_type": effective.get("compute_type") or "int8",
        "fallback_to_local": bool(effective.get("fallback_to_local")),
        "updated_at": row.updated_at if row else None,
        "updated_by": row.updated_by if row else None,
    }


# ── ASR 设置 ──────────────────────────────────────────────────────────

@router.get("/settings")
async def get_asr_settings(
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """读取当前生效的 ASR 设置（所有登录用户可读）。"""
    return await _build_settings_out(db)


@router.put("/settings")
async def update_asr_settings(
    body: AsrSettingsUpdate,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(get_current_admin),
):
    """保存 ASR 设置（仅 admin，涉及服务器基础设施配置）。"""
    data = body.model_dump(exclude_unset=True)
    await NoteAsrSettingsService.save_settings(
        db, data, user_name=admin.name or admin.email
    )
    return await _build_settings_out(db)


@router.post("/settings/test-remote")
async def test_remote_asr(
    db: AsyncSession = Depends(get_db),
    _admin: User = Depends(get_current_admin),
):
    """测试远程 ASR 网关连通性（仅 admin）。"""
    result = await NoteAsrSettingsService.test_remote_connection(db)
    return {
        "ok": bool(result.get("reachable")),
        "message": result.get("detail") or "",
    }


# ── 常用词库 ──────────────────────────────────────────────────────────

@router.get("/common-terms")
async def list_common_terms(
    keyword: str | None = Query(default=None),
    enabled_only: bool = Query(default=False),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """分页列举常用词，可按关键词与启用状态过滤。"""
    items = await NoteCommonTermService.list_terms(
        db, keyword=keyword, enabled_only=enabled_only, limit=limit, offset=offset
    )
    total = await NoteCommonTermService.count_terms(
        db, keyword=keyword, enabled_only=enabled_only
    )
    return {"items": [_to_common_term_out(t) for t in items], "total": total}


@router.post("/common-terms")
async def create_common_term(
    body: CommonTermCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """新建常用词条。"""
    data = body.model_dump(exclude_unset=True)
    term = await NoteCommonTermService.create_term(
        db, data, user_name=user.name or user.email
    )
    return _to_common_term_out(term)


@router.patch("/common-terms/{term_id}")
async def update_common_term(
    term_id: uuid.UUID,
    body: CommonTermUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """更新常用词条。"""
    data = body.model_dump(exclude_unset=True)
    term = await NoteCommonTermService.update_term(db, term_id, data)
    if not term:
        raise NotFoundException("Common term")
    return _to_common_term_out(term)


@router.delete("/common-terms/{term_id}")
async def delete_common_term(
    term_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_user),
):
    """软删除常用词条。"""
    ok = await NoteCommonTermService.delete_term(db, term_id)
    if not ok:
        raise NotFoundException("Common term")
    return {"ok": True}