#!/usr/bin/env bash
# AIDriveNote 生产部署脚本（在服务器 ~/AIDriveNote 目录执行）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "错误: 缺少 .env 文件，请先复制并配置 .env.example"
  exit 1
fi

echo "==> 构建并启动容器..."
docker compose -f docker-compose.prod.yml up -d --build

echo "==> 等待 PostgreSQL 就绪..."
sleep 5

echo "==> 执行数据库迁移..."
docker compose -f docker-compose.prod.yml exec -T backend alembic upgrade head

echo "==> 健康检查..."
curl -sf http://127.0.0.1:3270/health
echo ""
curl -sf -o /dev/null -w "前端 HTTP %{http_code}\n" http://127.0.0.1:3270/

echo "==> 容器状态:"
docker compose -f docker-compose.prod.yml ps

echo ""
echo "部署完成。本地访问: http://127.0.0.1:3270"
echo "公网访问需确保云防火墙/安全组已放行 TCP 3270"
