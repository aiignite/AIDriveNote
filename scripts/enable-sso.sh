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

# 网关子路径：/note/ 由门户 Nginx 反代，Note 容器须启用 subpath 模式
upsert VITE_BASE_PATH "/note/"
upsert VITE_API_URL "/note/api/v1"
upsert NGINX_SUBPATH "1"
upsert APP_HEALTH_PATH "/note/health"
upsert CORS_ORIGINS "${CORS_ORIGINS:-https://aiignite.com.cn,https://www.aiignite.com.cn}"

grep -E '^(SSO_|VITE_|NGINX_SUBPATH|APP_HEALTH_PATH|CORS_ORIGINS)=' "$NOTE_ENV" \
  | sed 's/SECRET_KEY=.*/SECRET_KEY=***/'

cd "${HOME}/AIDriveNote"
docker compose -f docker-compose.prod.yml up -d --build backend frontend
echo "AIDriveNote SSO + 子路径模式已启用并重建"
