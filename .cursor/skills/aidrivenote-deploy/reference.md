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

### 2. 生产 `.env`（本地为源，rsync 自动同步）

生产配置的**源在本地仓库根目录 `.env`**（gitignored）。`deploy-remote.sh` 的 rsync 会把它覆盖到服务器
`~/AIDriveNote/.env`，并在覆盖前按"键名 + 值哈希"做漂移预检（只报键名不回显值）。不要直接在服务器上改
`.env`——下次发布会被本地版本覆盖。

首次部署前确认本地 `.env` 至少包含（`asr_gateway` 还以 `:?` 强制要求 `NOTE_ASR_REMOTE_API_KEY`）：

```bash
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<强密码>
POSTGRES_DB=ai_drive_note

# 主机名必须是 compose 服务名 postgres，不是 127.0.0.1
DATABASE_URL=postgresql+asyncpg://postgres:<强密码>@postgres:5432/ai_drive_note
DATABASE_URL_SYNC=postgresql://postgres:<强密码>@postgres:5432/ai_drive_note

SECRET_KEY=<openssl rand -hex 32>
CORS_ORIGINS=https://aiignite.com.cn,https://www.aiignite.com.cn

OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_MODEL=qwen2.5

# asr_gateway 必填
NOTE_ASR_REMOTE_API_KEY=<与 enable-sso / 语音服务约定的密钥>
NOTE_ASR_MODE=remote

# 子路径部署
VITE_BASE_PATH=/note/
VITE_API_URL=/note/api/v1
NGINX_SUBPATH=1
APP_HEALTH_PATH=/note/health

# 注册验证码真实发信（EMAIL_MOCK=true 时验证码只进后端日志，用户无法注册）
EMAIL_HOST=smtp.qq.com
EMAIL_PORT=465
EMAIL_USER=<发信邮箱>
EMAIL_PASS=<授权码>
EMAIL_FROM="AIDriveNote <发信邮箱>"
EMAIL_MOCK=false
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

1. SSH 密钥（**当前已配置**，2026-10-11 验证）：`ssh ubuntu@<DEPLOY_HOST>` 免密直连，所有 ssh/rsync 无需额外包装
2. 密码（无密钥的机器才需要）：在 `deploy.env` 设置 `AIDRIVENOTE_SSH_PASS`（勿提交 git）
   - 沙箱环境禁止分配 pty 时 `sshpass` 不可用，改用 `SSH_ASKPASS` 包装；优先 `ssh-copy-id` 配密钥

`scripts/deploy.env` 已加入 `.gitignore`。

---

## 子路径部署验证要点

站点挂在 `/note/`，验证时必须带前缀，否则会误判为部署失败：

| URL | 期望 | 说明 |
|-----|------|------|
| `http://HOST:3270/` | 301 | 根路径重定向，**正常** |
| `http://HOST:3270/health` | 404 | **正常**，health 不在子路径下（2026-10-11 起 `deploy-remote.sh` 已改查带前缀路径） |
| `http://HOST:3270/note/` | 200 + index.html | 前端正常 |
| `http://HOST:3270/note/health` | 200 + **JSON** | frontend nginx 将 `/note/health` 代理到 backend `/health`，是**真实健康端点** |
| `https://aiignite.com.cn/note/health` | 200 + **JSON** | 同上（经宿主机 nginx），外网验证首选 |

```bash
curl -s https://aiignite.com.cn/note/health
# → {"status":"ok","app":"AIDriveNote"}
```

SPA 深链（如 `/note/settings`）返回 200 + index.html 属正常，但只能证明前端在服务，
**不能**证明 API 健康——判断 API 一律用 `/note/health` 的 JSON。

**验证改动生效**时，别只 curl 状态码（旧产物也是 200），要 grep 构建产物中的标识字符串。

本机直查线上 bundle（无需登服务器，首选）：

```bash
HTML=$(curl -s https://aiignite.com.cn/note/)
JS=$(echo "$HTML" | grep -o '/note/assets/index-[^"]*\.js' | head -1)
curl -s "https://aiignite.com.cn$JS" | grep -c '<标识串>'
```

或登服务器 grep 容器内产物：

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

# 当前迁移版本（发布含 schema 变更后确认 = 本地 head）
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres -d ai_drive_note -c "SELECT version_num FROM alembic_version;"

# 数据库备份（发布含迁移前必做）
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U postgres ai_drive_note > backup_$(date +%F-%H%M).sql
```

---

## 性能相关

生产 frontend 镜像内置 nginx gzip（见 `frontend/nginx.conf` 与 `frontend/nginx.subpath.conf`）。
部署后确认（子路径部署资源挂在 `/note/assets/` 下）：

```bash
HTML=$(curl -s http://<HOST>:3270/note/)
JS=$(echo "$HTML" | grep -o '/note/assets/index-[^"]*\.js' | head -1)
curl -sI -H "Accept-Encoding: gzip" "http://<HOST>:3270$JS" | grep -i content-encoding
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
