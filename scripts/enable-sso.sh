#!/usr/bin/env bash
# 同步 SSO 配置：AIDriveNote 使用与 AIDriveAll 相同的 SECRET_KEY
set -euo pipefail

NOTE_ENV="${HOME}/AIDriveNote/.env"
ALL_ENV="${HOME}/AIDriveAll/.env"

if [[ ! -f "$NOTE_ENV" || ! -f "$ALL_ENV" ]]; then
  echo "错误: 缺少 .env 文件"
  exit 1
fi

# shellcheck source=/dev/null
source "$ALL_ENV"

upsert() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$NOTE_ENV"; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$NOTE_ENV"
  else
    echo "${k}=${v}" >> "$NOTE_ENV"
  fi
}

upsert SSO_ENABLED "true"
upsert SSO_SECRET_KEY "$SECRET_KEY"
upsert SSO_ISSUER "aidriveall"

grep -E '^SSO_' "$NOTE_ENV" | sed 's/SECRET_KEY=.*/SECRET_KEY=***/'

cd "${HOME}/AIDriveNote"
docker compose -f docker-compose.prod.yml up -d --build backend frontend
echo "AIDriveNote SSO 已启用并重建"
