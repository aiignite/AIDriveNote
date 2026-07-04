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

echo "==> 外网健康检查..."
if curl -sf --connect-timeout 15 "http://${HOST}:${FRONTEND_PORT}/health"; then
  echo ""
else
  echo "警告: 外网 health 检查失败，请确认安全组已放行 TCP ${FRONTEND_PORT}" >&2
fi

curl -s -o /dev/null -w "前端 HTTP %{http_code}, 总耗时 %{time_total}s\n" \
  --connect-timeout 15 "http://${HOST}:${FRONTEND_PORT}/" || true

echo ""
echo "部署完成: http://${HOST}:${FRONTEND_PORT}/"
