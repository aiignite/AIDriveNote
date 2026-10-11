#!/usr/bin/env bash
# 从本地工作区一键发布 AIDriveNote 到远程服务器
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIG="${AIDRIVENOTE_DEPLOY_CONFIG:-$ROOT/scripts/deploy.env}"
if [[ -f "$CONFIG" ]]; then
  # shellcheck source=/dev/null
  source "$CONFIG"
fi

HOST="${AIDRIVENOTE_DEPLOY_HOST:?请设置 AIDRIVENOTE_DEPLOY_HOST（见 scripts/deploy.env.example）}"
USER="${AIDRIVENOTE_DEPLOY_USER:-ubuntu}"
REMOTE_PATH="${AIDRIVENOTE_DEPLOY_PATH:-/home/ubuntu/AIDriveNote}"
FRONTEND_PORT="${AIDRIVENOTE_FRONTEND_PORT:-3270}"

ssh_wrap() {
  if [[ -n "${AIDRIVENOTE_SSH_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$AIDRIVENOTE_SSH_PASS" ssh -o StrictHostKeyChecking=no "${USER}@${HOST}" "$@"
  else
    ssh -o StrictHostKeyChecking=no "${USER}@${HOST}" "$@"
  fi
}

rsync_ssh() {
  if [[ -n "${AIDRIVENOTE_SSH_PASS:-}" ]] && command -v sshpass >/dev/null 2>&1; then
    echo "sshpass -p '$AIDRIVENOTE_SSH_PASS' ssh -o StrictHostKeyChecking=no"
  else
    echo "ssh -o StrictHostKeyChecking=no"
  fi
}

echo "==> 目标: ${USER}@${HOST}:${REMOTE_PATH}"

# 本地根 .env 是生产配置源，rsync 会覆盖服务器同名文件（不在 exclude 列表）。
# 发布前按"键名 + 值哈希"对比两侧差异，只报键名不回显值，避免配置漂移被无声覆盖。
env_key_hashes() {
  awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 "\t" $2 }' "$1" | while IFS=$'\t' read -r key val; do
    printf '%s %s\n' "$key" "$(printf '%s' "$val" | shasum | cut -c1-10)"
  done | sort
}

# 对比两份 "键 哈希" 文件，按键归类差异：值覆盖 / 本地将新增 / 服务器键将丢失
classify() {  # classify <local_hash_file> <remote_hash_file>
  awk '
    FILENAME == ARGV[1] { if (NF >= 2) lh[$1] = $2; next }
    { if (NF >= 2) rh[$1] = $2 }
    END {
      for (k in lh) {
        if (!(k in rh))          printf "本地将新增: %s\n", k
        else if (lh[k] != rh[k]) printf "值将覆盖: %s\n", k
      }
      for (k in rh) if (!(k in lh)) printf "服务器键将丢失: %s\n", k
    }' "$1" "$2" | sort
}

echo "==> 预检：.env 漂移检查（本地 .env 将覆盖服务器 .env）..."
if [[ -f .env ]]; then
  TMP_REMOTE_ENV="$(mktemp)"
  TMP_LOCAL_HASH="$(mktemp)"
  TMP_REMOTE_HASH="$(mktemp)"
  if ssh_wrap "cat ${REMOTE_PATH}/.env 2>/dev/null" > "$TMP_REMOTE_ENV" && [[ -s "$TMP_REMOTE_ENV" ]]; then
    env_key_hashes .env > "$TMP_LOCAL_HASH"
    env_key_hashes "$TMP_REMOTE_ENV" > "$TMP_REMOTE_HASH"
    DRIFT="$(classify "$TMP_LOCAL_HASH" "$TMP_REMOTE_HASH")"
    if [[ -n "$DRIFT" ]]; then
      echo "⚠️  本地 .env 与服务器存在差异（只列键名，不显示值）："
      echo "$DRIFT" | sed 's/^/   /'
    else
      echo "    一致，无漂移"
    fi
  else
    echo "⚠️  服务器上没有 .env（首次部署？），将以本地 .env 初始化"
  fi
  rm -f "$TMP_REMOTE_ENV" "$TMP_LOCAL_HASH" "$TMP_REMOTE_HASH"
else
  echo "⚠️  本地没有根 .env；服务器 .env 将保持不变"
fi

echo "==> 同步代码..."
rsync -avz \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude '__pycache__' \
  --exclude '.runtime-logs' \
  --exclude 'backend/.env' \
  --exclude '.git' \
  --exclude 'frontend/dist' \
  --exclude 'backend/.pytest_cache' \
  --exclude 'scripts/deploy.env' \
  -e "$(rsync_ssh)" \
  ./ "${USER}@${HOST}:${REMOTE_PATH}/"

echo "==> 远程构建与启动..."
ssh_wrap "cd ${REMOTE_PATH} && chmod +x deploy.sh && ./deploy.sh"

# 子路径部署下 /health 本身 404，真正的 JSON 健康端点在 ${VITE_BASE_PATH%/}/health
# （frontend nginx 的 location /note/health 代理到 backend /health）。
BASE="${VITE_BASE_PATH%/}"

echo "==> 外网健康检查..."
if curl -sf --connect-timeout 15 "http://${HOST}:${FRONTEND_PORT}${BASE}/health"; then
  echo ""
else
  echo "警告: 外网 health 检查失败（http://${HOST}:${FRONTEND_PORT}${BASE}/health），请确认安全组已放行 TCP ${FRONTEND_PORT} 且容器在运行" >&2
fi

curl -s -o /dev/null -w "前端 HTTP %{http_code}, 总耗时 %{time_total}s\n" \
  --connect-timeout 15 "http://${HOST}:${FRONTEND_PORT}${BASE}/" || true

echo ""
echo "部署完成: http://${HOST}:${FRONTEND_PORT}${BASE}/"
