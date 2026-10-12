"""匿名登录事件表 – 记录匿名用户的登录信息与会话生命周期。

设计要点：

- ``guest_id`` **故意不加外键**到 ``users``。匿名账号的数据到期即被物理清除，
  而事件记录需要在此之后仍然保留（用于统计与审计回溯），因此由应用层
  保证引用完整性，而非数据库外键。
- ``event_type`` 取值受限于固定枚举（见 ``app/services/guest_event_service.py``）：
  ``login`` / ``logout`` / ``session_end`` / ``purge`` / ``blocked``。
- **隐私边界**：本表仅允许写入元数据（IP、User-Agent、时长、数量）。
  ``detail`` 只接受固定枚举值，禁止写入笔记标题、正文、文件名等用户内容——
  否则事件表本身会变成数据泄露面，且与「匿名数据不长期保存」的承诺冲突。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "014_guest_events"
down_revision = "013_guest_users"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "guest_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # 无外键：账号清除后事件保留
        sa.Column("guest_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        # IPv6 最长 45 字符
        sa.Column("ip_address", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.String(300), nullable=True),
        sa.Column("event_at", sa.DateTime(timezone=True), nullable=False),
        # 会话存活时长（秒）；logout / session_end / purge 时记录
        sa.Column("session_duration_seconds", sa.Integer(), nullable=True),
        # 清除时的笔记数量，仅数量不涉及内容
        sa.Column("note_count_at_end", sa.Integer(), nullable=True),
        # 固定枚举值，绝不写入用户内容
        sa.Column("detail", sa.String(200), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # 单会话回溯（按时间倒序）
    op.create_index(
        "ix_guest_events_guest_id", "guest_events", ["guest_id", "event_at"],
    )
    # 时间线统计与按时间范围过滤
    op.create_index("ix_guest_events_event_at", "guest_events", ["event_at"])


def downgrade() -> None:
    op.drop_index("ix_guest_events_event_at", table_name="guest_events")
    op.drop_index("ix_guest_events_guest_id", table_name="guest_events")
    op.drop_table("guest_events")
