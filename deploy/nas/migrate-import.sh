#!/usr/bin/env bash
# AIDriveNote — 在 NAS 上导入数据库
#
# 用法：./migrate-import.sh /volume1/apps/aidrive/aidrive-backup-20261005.sql.gz
#
# ⚠️ 前置条件：
#   - deploy/nas/.env 已配置完成
#   - docker compose -f deploy/nas/docker-compose.nas.yml 已成功启动 postgres
#   - 目标数据库为空（首次迁移）或你确认可覆盖

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

BACKUP_FILE="${1:-}"
if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "用法: $0 <备份文件路径.sql.gz>"
  echo "示例: $0 /volume1/apps/aidrive/aidrive-backup-20261005.sql.gz"
  exit 1
fi

COMPOSE_ARGS=(-f deploy/nas/docker-compose.nas.yml)

if [[ ! -f .env ]]; then
  echo "错误：缺少 .env（请 cp deploy/nas/.env.nas.example .env 并填写）"
  exit 1
fi

set -a
# shellcheck source=/dev/null
source .env
set +a

DB_NAME="${POSTGRES_DB:-ai_drive_note}"
DB_USER="${POSTGRES_USER:-postgres}"
DATA_ROOT="${NAS_DATA_ROOT:-/volume1/apps/aidrive}"

echo "==> 确认 Postgres 运行中"
docker compose "${COMPOSE_ARGS[@]}" up -d postgres
sleep 5

echo "==> 当前库中表数量（导入前）"
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0"

echo ""
echo "==> 开始导入：$(basename "$BACKUP_FILE")"
gunzip -c "$BACKUP_FILE" | docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1

echo ""
echo "==> 执行 Alembic 迁移（确保 schema 为最新）"
docker compose "${COMPOSE_ARGS[@]}" run --rm --no-deps backend alembic upgrade head

echo ""
echo "==> 导入后表数量"
docker compose "${COMPOSE_ARGS[@]}" exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

# ─────────────────────────────────────────────
# 恢复 uploads 附件（若存在）
# ─────────────────────────────────────────────
UPLOAD_TAR="$(dirname "$BACKUP_FILE")/aidrive-uploads-"*.tar.gz
if compgen -G "$UPLOAD_TAR" > /dev/null; then
  echo ""
  echo "==> 恢复 uploads 附件"
  mkdir -p "$DATA_ROOT/uploads"
  tar xzf $UPLOAD_TAR -C "$DATA_ROOT/uploads"
  chmod -R 777 "$DATA_ROOT/uploads"
  echo "✅ 附件已恢复到 $DATA_ROOT/uploads"
else
  echo ""
  echo "ℹ️  未找到 uploads 备份包，跳过附件恢复"
fi

echo ""
echo "✅ 迁移完成"
echo ""
echo "启动完整服务："
echo "  docker compose -f deploy/nas/docker-compose.nas.yml up -d"
echo ""
echo "健康检查："
echo "  curl -sf http://127.0.0.1:3270/note/health"
