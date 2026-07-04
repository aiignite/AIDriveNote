---
name: aidrivenote-deploy
description: >-
  Deploy AIDriveNote to a remote Ubuntu server via Docker Compose (rsync + build).
  Use when the user asks to deploy, publish, release, or update AIDriveNote on a
  remote server, SSH production host, port 3270, or docker-compose.prod.yml.
---

# AIDriveNote 远程部署

将 AIDriveNote 从本地工作区发布到远程 Ubuntu 服务器（Docker Compose 三容器：postgres + backend + frontend）。

## 架构速览

| 组件 | 容器端口 | 宿主机 |
|------|----------|--------|
| frontend (nginx) | 80 | `0.0.0.0:3270` |
| backend (FastAPI) | 3275 | `127.0.0.1:3275`（仅本机） |
| postgres | 5432 | 内部网络 |

访问地址：`http://<HOST>:3270`

## Agent 执行清单

```
部署进度：
- [ ] 1. 确认本地构建通过（可选）
- [ ] 2. 加载部署配置（deploy.env）
- [ ] 3. rsync 同步代码到服务器
- [ ] 4. 远程执行 deploy.sh（build + migrate + health）
- [ ] 5. 外网验证 HTTP / gzip / health
- [ ] 6. 汇报 URL 与结果
```

**禁止**将 SSH 密码、`.env` 密钥写入 git 或 skill 文件。凭据只来自用户提供的 `deploy.env` 或环境变量。

## 快速部署（推荐）

```bash
# 1. 首次：复制并编辑配置
cp scripts/deploy.env.example scripts/deploy.env
# 编辑 scripts/deploy.env（HOST、USER；优先配置 SSH 密钥，少用密码）

# 2. 一键发布
./scripts/deploy-remote.sh
```

Agent 应**实际运行**上述脚本，并在失败时按 [reference.md](reference.md) 排查。

## 分步手动部署

### Step 1 — 本地预检（可选）

```bash
cd frontend && npm run build
cd ../backend && AIDRIVE_TESTING=1 pytest --asyncio-mode=auto -q
```

### Step 2 — 同步代码

```bash
source scripts/deploy.env   # 或 export 环境变量

RSYNC_SSH="ssh -o StrictHostKeyChecking=no"
# 若使用密码且已安装 sshpass：RSYNC_SSH="sshpass -p \"$AIDRIVENOTE_SSH_PASS\" ssh -o StrictHostKeyChecking=no"

rsync -avz \
  --exclude 'node_modules' --exclude '.venv' --exclude '__pycache__' \
  --exclude '.runtime-logs' --exclude 'backend/.env' --exclude '.git' \
  --exclude 'frontend/dist' --exclude 'backend/.pytest_cache' \
  --exclude 'scripts/deploy.env' \
  -e "$RSYNC_SSH" \
  ./ "${AIDRIVENOTE_DEPLOY_USER}@${AIDRIVENOTE_DEPLOY_HOST}:${AIDRIVENOTE_DEPLOY_PATH}/"
```

**不要** rsync 覆盖服务器上的 `~/AIDriveNote/.env`（已在 exclude 列表）。

### Step 3 — 远程构建与启动

```bash
ssh "${AIDRIVENOTE_DEPLOY_USER}@${AIDRIVENOTE_DEPLOY_HOST}" \
  "cd ${AIDRIVENOTE_DEPLOY_PATH} && chmod +x deploy.sh && ./deploy.sh"
```

`deploy.sh` 会执行：`docker compose -f docker-compose.prod.yml up -d --build` → `alembic upgrade head` → 本地 health 检查。

### Step 4 — 外网验证

```bash
HOST="${AIDRIVENOTE_DEPLOY_HOST}"
PORT="${AIDRIVENOTE_FRONTEND_PORT:-3270}"

curl -sf "http://${HOST}:${PORT}/health"
curl -sI -H "Accept-Encoding: gzip" "http://${HOST}:${PORT}/" | grep -i content-encoding
curl -s -o /dev/null -w "ttfb:%{time_starttransfer}s total:%{time_total}s\n" "http://${HOST}:${PORT}/"
```

期望：`health` 返回 `{"status":"ok","app":"AIDriveNote"}`；响应头含 `Content-Encoding: gzip`。

## 首次部署（服务器尚无项目）

完整步骤见 [reference.md](reference.md#首次部署)。摘要：

1. SSH 登录 Ubuntu，确认 Docker 已安装
2. 在服务器创建 `~/AIDriveNote/.env`（参考 `backend/.env.example`，**DATABASE_URL 主机名用 `postgres`**）
3. 腾讯云/安全组放行 **TCP 3270**（宿主机 iptables 不够，需云控制台入站规则）
4. 执行 `./scripts/deploy-remote.sh`

### 服务器 `.env` 要点

```bash
DATABASE_URL=postgresql+asyncpg://postgres:<PASSWORD>@postgres:5432/ai_drive_note
DATABASE_URL_SYNC=postgresql://postgres:<PASSWORD>@postgres:5432/ai_drive_note
SECRET_KEY=<随机64hex>
CORS_ORIGINS=http://<公网IP>:3270,http://localhost:3270
POSTGRES_PASSWORD=<与上面一致>
```

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 外网 `:3270` 超时 | 云安全组未放行 | 控制台添加入站 TCP 3270 |
| `alembic` 表已存在 | 曾用 create_all 建表 | `docker compose exec -T backend alembic stamp head` |
| 页面极慢 | 旧版未 gzip / 未代码分割 | 确认 `frontend/nginx.conf` 含 gzip；重新 build frontend |
| API 401 正常 | 未登录 | 引导用户 `/register` 注册 |

## 相关文件

| 路径 | 用途 |
|------|------|
| `scripts/deploy-remote.sh` | 本地一键发布 |
| `scripts/deploy.env.example` | 部署配置模板 |
| `deploy.sh` | 服务器端构建/迁移/检查 |
| `docker-compose.prod.yml` | 生产 Compose |
| `docs/plans/AIDriveNote前端加载优化.md` | 前端性能优化说明 |

## 附加说明

- 仅当用户**明确要求**时才 `git commit` / `git push`
- 部署完成后告知用户访问 URL，**不要**在回复中复述密码
- 更新部署 ≠ 备份数据库；需要备份时单独 `docker compose exec postgres pg_dump`
