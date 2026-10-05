#!/usr/bin/env bash
# AIDriveNote — 从云服务器迁移数据库到 NAS
#
# 用法：
#   1) 在【云服务器】上执行导出：
#        ./migrate-export.sh
#        # 产出 ~/aidrive-backup-<日期>.sql.gz
#
#   2) 拷贝到 NAS（建议从云端主动推送，避开家宽上行瓶颈）：
#        # 在云服务器上执行
#        scp ~/aidrive-backup-*.sql.gz root@10.10.0.2:/volume1/apps/aidrive/
#
#   3) 在【NAS】上执行导入：
#        ./migrate-import.sh /volume1/apps/aidrive/aidrive-backup-20261005.sql.gz
#
# ⚠️ 导入前务必确认目标 Postgres 为空或可覆盖，否则会与现有数据冲突

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE="docker compose -f deploy/nas/docker-compose.nas.yml"

# ─────────────────────────────────────────────
# 导出（云服务器）
# ─────────────────────────────────────────────
cat <<'EOF'
════════════════════════════════════════════
 AIDriveNote 数据库导出
════════════════════════════════════════════
EOF

if [[ ! -f .env ]]; then
  echo "错误：缺少 .env 文件（在云服务器项目根目录执行）"
  exit 1
fi

set -a
# shellcheck source=/dev/null
source .env
set +a

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$HOME/aidrive-backup-$STAMP.sql.gz"

echo "==> 导出数据库 ${POSTGRES_DB:-ai_drive_note} → $OUT"
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-postgres}" --clean --if-exists "${POSTGRES_DB:-ai_drive_note}" \
  | gzip > "$OUT"

echo "==> 导出 uploads 附件目录"
UPLOAD_TAR="$HOME/aidrive-uploads-$STAMP.tar.gz"
docker run --rm \
  -v "${PWD}/backend/uploads:/src:ro" \
  -v "$HOME:/dst" \
  alpine tar czf "/dst/$(basename "$UPLOAD_TAR")" -C /src .

echo ""
echo "✅ 导出完成："
ls -lh "$OUT" "$UPLOAD_TAR"
echo ""
echo "下一步（仍在云服务器）："
echo "  scp $UPLOAD_TAR root@10.10.0.2:/volume1/apps/aidrive/"
echo "  # 或直接拷贝到本机再传入 NAS"
