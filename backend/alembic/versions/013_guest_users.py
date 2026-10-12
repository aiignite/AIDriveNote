"""匿名登录：为 ``users`` 增加访客标记与存活时间。

新增列：

- ``is_guest``：匿名账号标记。匿名账号 ``role`` 固定为 ``guest``，永不是管理员，
  且其数据到期后由后台定时任务物理清除。
- ``last_seen_at``：最后一次请求时间，作为「离线宽限期」的计时基准。
  由 ``app/auth.py`` 的 ``get_current_user`` 以节流方式刷新。
- ``guest_purged_at``：清除完成标记，保证清除任务幂等——账号行残留时（异常中断）
  后续扫描会跳过，不会反复对同一账号执行删除。

沿用 011 的 ``_has_column`` 幂等检查风格。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "013_guest_users"
down_revision = "012_email_verification_codes"
branch_labels = None
depends_on = None

# 需要新增的列：(列名, 类型, 是否 NOT NULL, server_default)
# is_guest 恒有值（非空，默认 false），与 ORM 的 Mapped[bool] 一致；
# 两个时间列必须可空：last_seen_at 允许 NULL（账号创建后尚无请求），
# guest_purged_at 允许 NULL（尚未清除）。
_COLUMNS = (
    ("is_guest", sa.Boolean(), True, sa.text("false")),
    ("last_seen_at", sa.DateTime(timezone=True), False, None),
    ("guest_purged_at", sa.DateTime(timezone=True), False, None),
)


def _has_column(conn, table: str, column: str) -> bool:
    """幂等检查：列是否已存在。"""
    return bool(
        conn.execute(
            sa.text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = :t AND column_name = :c"
            ),
            {"t": table, "c": column},
        ).first()
    )


def upgrade() -> None:
    """为 users 表补充匿名登录相关字段与扫描索引。

    用 ``ALTER TABLE ADD COLUMN`` 而非 ``op.add_column``：后者在部分
    SQLAlchemy 版本上对带 server_default 的布尔列存在兼容问题，
    这里走原生 DDL，同时保留 011 的幂等检查风格。
    """
    conn = op.get_bind()

    for name, col_type, not_null, default in _COLUMNS:
        if _has_column(conn, "users", name):
            continue
        ddl = f'ALTER TABLE users ADD COLUMN "{name}" {col_type.compile(conn.dialect)}'
        if default is not None:
            ddl += f" DEFAULT {default}"
        if not_null:
            ddl += " NOT NULL"
        conn.execute(sa.text(ddl))

    # 定时扫描「匿名且超过宽限期未活动」的账号，走该复合索引
    conn.execute(
        sa.text(
            "CREATE INDEX IF NOT EXISTS ix_users_guest_purge "
            "ON users (is_guest, last_seen_at)"
        )
    )


def downgrade() -> None:
    """移除匿名登录字段与索引。"""
    conn = op.get_bind()
    conn.execute(sa.text("DROP INDEX IF EXISTS ix_users_guest_purge"))
    for name, _col_type, _nullable, _default in reversed(_COLUMNS):
        if _has_column(conn, "users", name):
            conn.execute(sa.text(f'ALTER TABLE users DROP COLUMN "{name}"'))
