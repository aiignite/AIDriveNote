#!/usr/bin/env bash
# 将 aiignite.com.cn/note 指向 AIDriveNote Docker（:3270）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF_SRC="$ROOT/deploy/nginx/aiignite-note.conf"
CONF_DST="/etc/nginx/sites-available/aiignite-note"

if [[ ! -f "$CONF_SRC" ]]; then
  echo "缺少 $CONF_SRC"
  exit 1
fi

echo "==> 安装 host nginx 配置..."
sudo cp "$CONF_SRC" "$CONF_DST"
sudo ln -sf "$CONF_DST" /etc/nginx/sites-enabled/aiignite-note
sudo nginx -t
sudo systemctl reload nginx
echo "==> nginx 已重载，https://aiignite.com.cn/note/ 将反代到 127.0.0.1:3270"
