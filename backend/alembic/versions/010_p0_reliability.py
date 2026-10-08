"""P0 可靠性加固：修订置位列、note_type 约束、中文检索（pg_trgm + 可选 zhparser）。

对应《AIDriveNote 产品能力演进方案》P0-1 / P0-2 / P0-5。
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "010_p0_reliability"
down_revision = "009_note_recordings"
branch_labels = None
depends_on = None

NOTE_TYPES = ("rich_text", "markdown", "mindmap", "flowchart")


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


def _extension_available(conn, name: str) -> bool:
    return bool(conn.execute(sa.text("SELECT 1 FROM pg_available_extensions WHERE name = :n"), {"n": name}).first())


def upgrade() -> None:
    conn = op.get_bind()

    # ── P0-1：修订历史置位列 + 单调序号 ──
    # 「恢复前快照」等关键节点置位后不参与「保留最近 N 条」的淘汰。
    if not _has_column(conn, "note_revisions", "is_pinned"):
        op.add_column(
            "note_revisions",
            sa.Column(
                "is_pinned",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )
        op.create_index(
            "ix_note_revisions_note_id_is_pinned",
            "note_revisions",
            ["note_id", "is_pinned"],
        )

    # seq：created_at 由 server_default 生成，同一秒创建的修订时间戳相同，
    # 无法作为「保留最新 N 条」的排序键（UUIDv4 也不可排序）。用窗口函数按
    # (created_at, id) 回填，保证存量数据也有稳定序号。
    if not _has_column(conn, "note_revisions", "seq"):
        op.add_column(
            "note_revisions",
            sa.Column("seq", sa.Integer(), nullable=False, server_default=sa.text("0")),
        )
        conn.execute(
            sa.text(
                """
                WITH ranked AS (
                    SELECT id,
                           ROW_NUMBER() OVER (
                               PARTITION BY note_id
                               ORDER BY created_at ASC, id ASC
                           ) AS rn
                    FROM note_revisions
                )
                UPDATE note_revisions r
                SET seq = ranked.rn
                FROM ranked
                WHERE r.id = ranked.id
                """
            )
        )
        op.create_index(
            "ix_note_revisions_note_id_seq",
            "note_revisions",
            ["note_id", "seq"],
        )

    # ── P0-5：note_type 取值约束 ──
    # 既有脏数据（不在四种类型内的值）先清理为 markdown，避免加约束失败。
    allowed = ", ".join(f"'{t}'" for t in NOTE_TYPES)
    conn.execute(
        sa.text(
            "UPDATE note_notes SET note_type = 'markdown' "
            f"WHERE note_type IS NULL OR note_type NOT IN ({allowed})"
        )
    )
    op.execute("ALTER TABLE note_notes DROP CONSTRAINT IF EXISTS ck_note_notes_note_type")
    op.execute(
        "ALTER TABLE note_notes ADD CONSTRAINT ck_note_notes_note_type "
        "CHECK (note_type IN ('rich_text', 'markdown', 'mindmap', 'flowchart'))"
    )

    # ── P0-5：note_no 生成支撑索引 ──
    # _next_note_no 改为「按前缀查最大编号」，(note_no) 上的 LIKE 前缀查询需要该索引。
    op.execute("CREATE INDEX IF NOT EXISTS ix_note_notes_note_no_prefix ON note_notes (note_no text_pattern_ops)")

    # 并发安全的编号分配：事务级咨询锁把「查最大值 + 占号」串行化，
    # 消除原先 SELECT MAX()+1 的竞态（并发创建拿到相同编号）。
    op.execute(
        """
        CREATE OR REPLACE FUNCTION app_next_note_no(p_year integer)
        RETURNS varchar AS $$
        DECLARE
            v_prefix text := 'NT' || p_year;
            v_next integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext(v_prefix));
            SELECT COALESCE(MAX(SUBSTRING(note_no FROM 7))::integer, 0) + 1
              INTO v_next
              FROM note_notes
             WHERE note_no LIKE v_prefix || '%';
            RETURN v_prefix || LPAD(v_next::text, 6, '0');
        END;
        $$ LANGUAGE plpgsql
        """
    )

    # ── P0-2：中文全文检索 ──
    # 'simple' 分词配置不切分中文，导致 TSVECTOR 对中文近乎无效。
    # 首选 zhparser（真正分词）；不可用时退回 pg_trgm（三元组，中文同样有效）。
    has_zhparser = _extension_available(conn, "zhparser")
    if has_zhparser:
        op.execute("CREATE EXTENSION IF NOT EXISTS zhparser")
        conn.execute(
            sa.text("UPDATE note_notes SET search_vector = NULL WHERE search_vector IS NOT NULL")
        )
        conn.execute(
            sa.text(
                "UPDATE note_notes SET search_vector = "
                "to_tsvector('zhparser', coalesce(search_text, '')) WHERE search_text IS NOT NULL"
            )
        )
    else:
        op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_note_notes_title_trgm "
            "ON note_notes USING gin (title gin_trgm_ops)"
        )
        op.execute(
            "CREATE INDEX IF NOT EXISTS ix_note_notes_search_text_trgm "
            "ON note_notes USING gin (search_text gin_trgm_ops)"
        )
        # 存量 TSVECTOR 保持 simple 配置，仅作为英文/数字词的补充召回
        conn.execute(
            sa.text(
                "UPDATE note_notes SET search_vector = "
                "to_tsvector('simple', coalesce(search_text, '')) WHERE search_text IS NOT NULL"
            )
        )


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS app_next_note_no(integer)")
    op.execute("ALTER TABLE note_notes DROP CONSTRAINT IF EXISTS ck_note_notes_note_type")
    op.execute("DROP INDEX IF EXISTS ix_note_notes_note_no_prefix")
    op.execute("DROP INDEX IF EXISTS ix_note_notes_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_note_notes_search_text_trgm")
    op.execute("DROP INDEX IF EXISTS ix_note_revisions_note_id_is_pinned")
    op.execute("DROP INDEX IF EXISTS ix_note_revisions_note_id_seq")
    with op.batch_alter_table("note_revisions") as batch:
        batch.drop_column("is_pinned")
        batch.drop_column("seq")