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

在服务器 `~/AIDriveNote/.env`（**不要**从本机 rsync 覆盖）。注意 `asr_gateway` 服务还会额外要求
`NOTE_ASR_REMOTE_API_KEY`（[docker-compose.prod.yml](../../docker-compose.prod.yml) 中以 `:?` 标注的必填项）：

```bash
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<强密码>
POSTGRES_DB=ai_drive_note

DATABASE_URL=postgresql+asyncpg://postgres:<强密码>@postgres:5432/ai_drive_note
DATABASE_URL_SYNC=postgresql://postgres:<强密码>@postgres:5432/ai_drive_note

SECRET_KEY=<openssl rand -hex 32>
CORS_ORIGINS=http://<DEPLOY_HOST>:3270,http://localhost:3270

OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5

# asr_gateway 必填
NOTE_ASR_REMOTE_API_KEY=<与 enable-sso / 语音服务约定的密钥>
NOTE_ASR_MODE=remote
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
AIDRIVENOTE_DEPLOY_HOST=<DEPLOY_HOST>
AIDRIVENOTE_DEPLOY_USER=ubuntu
AIDRIVENOTE_DEPLOY_PATH=/home/ubuntu/AIDriveNote
AIDRIVENOTE_FRONTEND_PORT=3270

# 生产子路径（非根目录！验证 URL 时必须带上）
VITE_BASE_PATH=/note/
NGINX_SUBPATH=1
APP_HEALTH_PATH=/note/health
```

**SSH 认证优先级：**

1. SSH 密钥（推荐）：`ssh-copy-id ubuntu@<HOST>` — 之后所有 ssh/rsync 命令都无需额外包装
2. 密码：在 `deploy.env` 设置 `AIDRIVENOTE_SSH_PASS`（勿提交 git）
   - 沙箱环境禁止分配 pty 时 `sshpass` 不可用，改用 `SSH_ASKPASS`（见 SKILL.md「凭据处理」）

`scripts/deploy.env` 已加入 `.gitignore`。

---

## 子路径部署验证要点

站点挂在 `/note/`，验证时必须带前缀，否则会误判为部署失败：

| URL | 期望 | 说明 |
|-----|------|------|
| `http://HOST:3270/` | 301 | 根路径重定向，**正常** |
| `http://HOST:3270/health` | 404 | **正常**，health 不在子路径下 |
| `http://HOST:3270/note/` | 200 + index.html | 前端正常 |
| `http://HOST:3270/note/health` | 200 + index.html | 被 SPA 兜底，**不能**据此判断 API 健康 |

API 健康的权威判据是远程 `deploy.sh` 在服务器本机执行的结果（[deploy.sh](../../deploy.sh) 用
`${APP_HEALTH_PATH:-/health}` 拼路径，故子路径部署时应把它设为 `/note/health`）：

```bash
# 在服务器上执行，deploy.sh 已自动完成
curl -sf "http://127.0.0.1:3270${APP_HEALTH_PATH:-/health}"
# → {"status":"ok","app":"AIDriveNote"}
```

**验证改动生效**时，别只 curl 状态码（旧产物也是 200），要 grep 容器内产物：

```bash
docker exec aidrivenote-frontend-1 sh -c \
  'grep -o ".\{130\}无标题笔记" /usr/share/nginx/html/assets/NotesPage-*.js'
```

注意 terser 会剥掉注释，只能 grep 实际代码或字符串字面量。

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
| 默认 HOST | <DEPLOY_HOST> |
| 区域 | 腾讯云 ap-singapore |
| 实例 | ins-2z2g50u8 |
| 部署路径 | /home/ubuntu/AIDriveNote |

（凭据不在此文档存储。）
