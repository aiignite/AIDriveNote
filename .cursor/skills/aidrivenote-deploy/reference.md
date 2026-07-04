# AIDriveNote 部署参考

## 首次部署

### 1. 服务器环境

```bash
# Ubuntu 24.04 示例
docker --version    # 需 20+
docker compose version
free -h             # 建议 ≥2GB 可用内存
```

安装 Docker（若缺失）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
# 重新登录 SSH 会话
```

### 2. 创建生产 `.env`

在服务器 `~/AIDriveNote/.env`（**不要**从本机 rsync 覆盖）：

```bash
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<强密码>
POSTGRES_DB=ai_drive_note

DATABASE_URL=postgresql+asyncpg://postgres:<强密码>@postgres:5432/ai_drive_note
DATABASE_URL_SYNC=postgresql://postgres:<强密码>@postgres:5432/ai_drive_note

SECRET_KEY=<openssl rand -hex 32>
CORS_ORIGINS=http://43.134.98.176:3270,http://localhost:3270

OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5
```

生成 SECRET_KEY：

```bash
openssl rand -hex 32
```

### 3. 云防火墙

腾讯云 CVM：控制台 → 安全组 → 入站规则 → **TCP 3270** 来源 `0.0.0.0/0`（或限定 IP）。

验证（在**本地**执行）：

```bash
nc -z -w 5 <HOST> 3270 && echo OPEN || echo BLOCKED
```

### 4. 首次 stamp（仅当 alembic 报错表已存在）

```bash
cd ~/AIDriveNote
docker compose -f docker-compose.prod.yml exec -T backend alembic stamp head
```

---

## deploy.env 配置

复制 `scripts/deploy.env.example` → `scripts/deploy.env`：

```bash
AIDRIVENOTE_DEPLOY_HOST=43.134.98.176
AIDRIVENOTE_DEPLOY_USER=ubuntu
AIDRIVENOTE_DEPLOY_PATH=/home/ubuntu/AIDriveNote
AIDRIVENOTE_FRONTEND_PORT=3270
```

**SSH 认证优先级：**

1. SSH 密钥（推荐）：`ssh-copy-id ubuntu@<HOST>`
2. 密码：在 `deploy.env` 设置 `AIDRIVENOTE_SSH_PASS`（勿提交 git）

`scripts/deploy.env` 已加入 `.gitignore`。

---

## 运维命令（在服务器上）

```bash
cd ~/AIDriveNote

# 状态
docker compose -f docker-compose.prod.yml ps

# 日志
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend
docker compose -f docker-compose.prod.yml logs -f --tail=100 frontend

# 重启单服务
docker compose -f docker-compose.prod.yml restart frontend

# 完全重建
docker compose -f docker-compose.prod.yml up -d --build

# 数据库备份
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres ai_drive_note > backup_$(date +%F).sql
```

---

## 性能相关

生产 frontend 镜像内置 nginx gzip（见 `frontend/nginx.conf`）。部署后确认：

```bash
curl -sI -H "Accept-Encoding: gzip" "http://<HOST>:3270/assets/index-*.js" | grep -i content-encoding
# 应看到 Content-Encoding: gzip
```

详见 `docs/plans/AIDriveNote前端加载优化.md`。

---

## 已知生产环境

| 项 | 值 |
|----|-----|
| 默认 HOST | 43.134.98.176 |
| 区域 | 腾讯云 ap-singapore |
| 实例 | ins-2z2g50u8 |
| 部署路径 | /home/ubuntu/AIDriveNote |

（凭据不在此文档存储。）
