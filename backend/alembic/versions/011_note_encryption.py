"""笔记/文件夹加密字段。

为 `note_notes` 与 `note_folders` 增加加密相关列：

- ``is_encrypted``：是否启用加密（笔记级 / 文件夹级）
- ``enc_salt``：密钥派生盐（base64）
- ``enc_verifier``：密码校验器（bcrypt 哈希）

设计参考 `010_p0_reliability`，使用 ``_has_column`` 做幂等检查。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "011_note_encryption"
down_revision = "010_p0_reliability"
branch_labels = None
depends_on = None

# 需要新增加密列的（表名, 注释）
_TABLES = ("note_notes", "note_folders")


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
    """为笔记表与文件夹表补充加密字段。"""
    conn = op.get_bind()
    for table in _TABLES:
        if not _has_column(conn, table, "is_encrypted"):
            op.add_column(
                table,
                sa.Column(
                    "is_encrypted",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.text("false"),
                ),
            )
        if not _has_column(conn, table, "enc_salt"):
            op.add_column(table, sa.Column("enc_salt", sa.String(length=64), nullable=True))
        if not _has_column(conn, table, "enc_verifier"):
            op.add_column(table, sa.Column("enc_verifier", sa.String(length=255), nullable=True))


def downgrade() -> None:
    """移除加密字段。"""
    for table in _TABLES:
        with op.batch_alter_table(table) as batch:
            batch.drop_column("enc_verifier")
            batch.drop_column("enc_salt")
            batch.drop_column("is_encrypted")
