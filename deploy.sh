#!/usr/bin/env bash
# AIDriveNote 生产部署脚本（在服务器 ~/AIDriveNote 目录执行）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

if [[ ! -f .env ]]; then
  echo "错误: 缺少 .env 文件，请先复制并配置 .env.example"
  exit 1
fi

echo "==> 构建后端镜像..."
docker compose -f docker-compose.prod.yml build backend

echo "==> 启动 PostgreSQL..."
docker compose -f docker-compose.prod.yml up -d postgres

echo "==> 等待 PostgreSQL 就绪..."
for _ in $(seq 1 30); do
  pg_id="$(docker compose -f docker-compose.prod.yml ps -q postgres)"
  status="$(docker inspect --format '{{.State.Health.Status}}' "$pg_id" 2>/dev/null || echo unknown)"
  if [[ "$status" == "healthy" ]]; then
    break
  fi
  sleep 2
done

# 先迁移再启动后端：后端 lifespan 会查询新列/种子数据，旧 schema 下会启动失败
echo "==> 执行数据库迁移..."
docker compose -f docker-compose.prod.yml run --rm --no-deps backend alembic upgrade head

echo "==> 构建并启动全部容器..."
docker compose -f docker-compose.prod.yml up -d --build

echo "==> 健康检查..."
HEALTH_PATH="${APP_HEALTH_PATH:-/health}"
curl -sf "http://127.0.0.1:3270${HEALTH_PATH}"
echo ""
curl -sf -o /dev/null -w "前端 HTTP %{http_code}\n" "http://127.0.0.1:3270${VITE_BASE_PATH:-/}"

echo "==> 容器状态:"
docker compose -f docker-compose.prod.yml ps

echo ""
echo "部署完成。本地访问: http://127.0.0.1:3270"
echo "公网访问需确保云防火墙/安全组已放行 TCP 3270"
