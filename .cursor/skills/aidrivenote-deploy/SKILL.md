---
name: aidrivenote-deploy
description: >-
  Deploy/publish AIDriveNote to the remote Ubuntu server <DEPLOY_HOST> via rsync +
  docker compose (deploy-remote.sh). Use when the user asks to 部署/发布/上线/deploy/
  publish/release/update AIDriveNote, or mentions the production host, port 3270,
  docker-compose.prod.yml, ~/AIDriveNote, aiignite.com.cn/note, or SSH to the server.
  Covers code-only frontend changes as well as full rebuilds.
---

# AIDriveNote 远程部署

将 AIDriveNote 从本地工作区发布到远程 Ubuntu 服务器（Docker Compose：postgres + backend + frontend + asr_gateway）。

## ⚠️ 先读这一条：不要在本机找部署线索

本机（Mac）**不部署**本项目。首次部署时容易走错方向，请在动手前确认：

| 错误方向（本地） | 正确方向（远程） |
|------------------|------------------|
| `deploy.sh` 在本机跑 | `deploy.sh` **只在服务器**跑 |
| 本机需 `.env` | `.env` **只在服务器** `~/AIDriveNote/.env` |
| 本机 Docker daemon | 远程服务器 Docker |
| `start.sh`（本机 vite dev，端口 3270/3275） | 与生产部署**无关** |

- 权威配置：[scripts/deploy.env](scripts/deploy.env)（HOST/USER/PATH，已 gitignore）
- 一键脚本：[scripts/deploy-remote.sh](scripts/deploy-remote.sh) — **默认就用它**
- 用户说「部署了多次」时，指的就是这条路径，不要重新发明流程。

## 环境事实（已验证）

- 生产站点部署在子路径 `/note/`，**不是**站点根目录。`/` 返回 301，`/health` 返回 404 属正常。
- 服务器：`<DEPLOY_HOST>`，用户 `ubuntu`，路径 `/home/ubuntu/AIDriveNote`（腾讯云新加坡）
- 正式入口：`https://aiignite.com.cn/note/`；直连调试：`http://<DEPLOY_HOST>:3270/note/`

## 只改了前端时的推荐范围

若本次改动只涉及前端（未改 `backend/`、未改数据库模型），**优先只重建 frontend**：

```bash
docker compose -f docker-compose.prod.yml up -d --build frontend
```

这样避免 `alembic upgrade head` 与 asr_gateway 镜像重建（后者构建期会下载 Whisper 权重，耗时较长）。改动跨后端或涉及 schema 时才跑完整 `deploy.sh`。

## 凭据处理（重要）

`.env` / `sshpass` 密码**禁止**写入 git、skill 文件或终端输出。

本会话环境禁止分配 pty（`Failed to get a pseudo terminal`），因此 `sshpass` **不可用**。用 `SSH_ASKPASS` 绕过：

```bash
set -a && source scripts/deploy.env && set +a

AP="$(mktemp)"; printf '#!/bin/sh\necho "%s"\n' "$AIDRIVENOTE_SSH_PASS" > "$AP"; chmod 700 "$AP"
export SSH_ASKPASS="$AP" SSH_ASKPASS_REQUIRE=force DISPLAY=:

ssh -T -o StrictHostKeyChecking=no "$AIDRIVENOTE_DEPLOY_USER@$AIDRIVENOTE_DEPLOY_HOST" 'echo OK'
rm -f "$AP"      # 用完即删
```

rsync 同理，在 `-e` 后附加同样参数，并在 `--exclude` 中排除临时脚本：

```bash
rsync -avz --exclude 'node_modules' --exclude '.venv' --exclude '__pycache__' \
  --exclude '.runtime-logs' --exclude 'backend/.env' --exclude '.git' \
  --exclude 'frontend/dist' --exclude 'backend/.pytest_cache' \
  --exclude 'scripts/deploy.env' --exclude 'scripts/.askpass-tmp.sh' \
  -e "ssh -T -o StrictHostKeyChecking=no" \
  ./ "$AIDRIVENOTE_DEPLOY_USER@$AIDRIVENOTE_DEPLOY_HOST:$AIDRIVENOTE_DEPLOY_PATH/"
```

**首选**是配置 SSH 密钥（`ssh-copy-id`），密钥可用时上述 askpass 包装全部不需要。

## 架构速览

| 组件 | 容器端口 | 宿主机 |
|------|----------|--------|
| frontend (nginx) | 80 | `0.0.0.0:3270` |
| backend (FastAPI) | 3275 | `127.0.0.1:3275`（仅本机） |
| postgres | 5432 | 内部网络 |
| asr_gateway | 8090 | `127.0.0.1:8091` |

| 入口 | 地址 | 协议 | 用途 |
|------|------|------|------|
| 线上正式（推荐） | `https://aiignite.com.cn/note/` | HTTP/2 + TLS | 面向用户，多路复用、首屏更快 |
| 直连调试 | `http://<HOST>:3270/note/` | HTTP/1.1 | 仅用于排查容器/nginx 问题，连接数上限 6，速度明显更慢 |

> 性能提示：直连 `:3270` 走 HTTP/1.1，浏览器单域名并发上限 6，且无 TLS 复用；跨机房 RTT 约 0.7s 时差距会被放大。验收性能请以域名入口为准。

## Agent 执行清单

```
部署进度：
- [ ] 1. 确认目标（远程服务器，不是本机）与改动范围（仅前端？）
- [ ] 2. 加载 scripts/deploy.env
- [ ] 3. 本地 type-check 通过（前端改动：cd frontend && npx tsc --noEmit）
- [ ] 4. rsync 同步代码到服务器
- [ ] 5. 远程执行 deploy.sh（或仅 frontend）
- [ ] 6. 验证产物确实含本次改动
- [ ] 7. 汇报 URL 与结果
```

**禁止**将 SSH 密码、`.env` 密钥写入 git 或 skill 文件。凭据只来自 `deploy.env` 或环境变量。

## 快速部署（推荐）

```bash
# 首次：复制并编辑配置
cp scripts/deploy.env.example scripts/deploy.env
# 编辑 scripts/deploy.env（HOST、USER；优先配置 SSH 密钥，少用密码）

# 一键发布（内部已处理 rsync + 远程 deploy.sh + 外网检查）
./scripts/deploy-remote.sh
```

若脚本因 pty 限制失败，按上文「凭据处理」改用 `SSH_ASKPASS` 手动执行 rsync + ssh 两步。

Agent 应**实际运行**部署，并在失败时按 [reference.md](reference.md) 排查。

## 分步手动部署

### Step 1 — 本地预检（可选）

```bash
cd frontend && npm run build
cd ../backend && AIDRIVE_TESTING=1 pytest --asyncio-mode=auto -q
```

### Step 2 — 同步代码

见上文「凭据处理」的完整 rsync 命令（含 `SSH_ASKPASS` 与 askpass 脚本的 exclude）。

**不要** rsync 覆盖服务器上的 `~/AIDriveNote/.env`（已在 exclude 列表）。

### Step 3 — 远程构建与启动

```bash
ssh "${AIDRIVENOTE_DEPLOY_USER}@${AIDRIVENOTE_DEPLOY_HOST}" \
  "cd ${AIDRIVENOTE_DEPLOY_PATH} && chmod +x deploy.sh && ./deploy.sh"
```

`deploy.sh` 会执行：`docker compose -f docker-compose.prod.yml up -d --build` → `alembic upgrade head` → 本地 health 检查。

> 本机沙箱禁止 `/bin/ps`，`start.sh` 会在端口检查处失败（`Operation not permitted`）。这与远程部署无关，不要因此去改 `start.sh` 或改用本机服务。

### Step 4 — 验证产物含本次改动（关键）

**只看 HTTP 200 不够** —— 旧产物同样返回 200。必须确认构建结果确实包含本次改动：

```bash
# 4.1 源码已同步
ssh ... "grep -c '<本次改动的标识字符串>' ${REMOTE_PATH}/frontend/src/pages/NotesPage.tsx"

# 4.2 容器内的构建产物含该逻辑
ssh ... "docker exec aidrivenote-frontend-1 sh -c \
  'grep -o \".\{130\}<中文标识字符串>\" /usr/share/nginx/html/assets/<Chunk>-*.js'"
```

用 `grep -o` 截取改动点周围的压缩代码来判读。terser 会剥离注释，所以**不要** grep 注释里的中文，只能 grep 实际代码/字符串字面量（如 `'无标题笔记'`）。

### Step 5 — 外网验证

```bash
HOST="${AIDRIVENOTE_DEPLOY_HOST}"
PORT="${AIDRIVENOTE_FRONTEND_PORT:-3270}"
BASE="${VITE_BASE_PATH%/}"     # /note

# 5.1 调试入口（子路径，勿用根路径）
curl -s -o /dev/null -w "%{http_code}\n" "http://${HOST}:${PORT}${BASE}/"
curl -sI -H "Accept-Encoding: gzip" "http://${HOST}:${PORT}${BASE}/" | grep -i content-encoding

# 5.2 正式入口（性能验收以此为准，HTTP/2）
curl -sI -H "Accept-Encoding: gzip" "https://aiignite.com.cn/note/" | grep -iE "content-encoding|http/"
curl -s -o /dev/null -w "ttfb:%{time_starttransfer}s total:%{time_total}s\n" "https://aiignite.com.cn/note/"
```

> **子路径陷阱**：`/health` 与 `/` 在子路径部署下分别返回 404 与 301，**这是正常的**，
> 不要据此判断部署失败。真正的 health 由远程 `deploy.sh` 在服务器本机执行（`127.0.0.1:3270`），
> 输出 `{"status":"ok","app":"AIDriveNote"}` 即通过。
> `APP_HEALTH_PATH` 已含 `/note` 前缀（如 `/note/health`），但该路径会被 SPA 兜底返回 index.html，
> 返回 200 + HTML 属正常现象，仅说明前端在服务，不足以证明 API 健康。

期望：页面与 **普通 JSON API** 响应头含 `Content-Encoding: gzip`。

> 注意：`POST /api/v1/ai/chat/stream`（SSE 流式对话）所在 location 有意关闭了 `proxy_buffering`，
> 该端点的响应**不会**被压缩，这是预期行为，流式输出必须逐条下发。

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
| 本机没有 `.env` / Docker 未运行 | **找错机器了** | 本机不部署。改用 `scripts/deploy-remote.sh` 推送到远程 |
| `Failed to get a pseudo terminal` | 沙箱禁止分配 pty，`sshpass` 失效 | 改用 `SSH_ASKPASS`（见「凭据处理」），或配置 SSH 密钥 |
| `/health` 404、`/` 301 | 子路径 `/note/` 部署，**正常** | 用 `${VITE_BASE_PATH%/}/` 验证；health 以服务器本机输出为准 |
| `start.sh` 在 `/bin/ps` 处中断 | 沙箱禁止 `/bin/ps` | 与部署无关；需要本机开发时手动起 uvicorn + vite |
| 外网 `:3270` 超时 | 云安全组未放行 | 控制台添加入站 TCP 3270 |
| `alembic` 表已存在 | 曾用 create_all 建表 | `docker compose exec -T backend alembic stamp head` |
| 页面极慢 | 旧版未 gzip / 未代码分割 | 确认 `frontend/nginx.conf` 含 gzip；重新 build frontend |
| API 401 正常 | 未登录 | 引导用户 `/register` 注册 |

## 相关文件

| 路径 | 用途 |
|------|------|
| `scripts/deploy-remote.sh` | 本地一键发布（rsync + 远程 deploy.sh） |
| `scripts/deploy.env` | 实际部署配置（gitignored，勿提交/勿外传） |
| `scripts/deploy.env.example` | 部署配置模板 |
| `deploy.sh` | 服务器端构建/迁移/检查 |
| `docker-compose.prod.yml` | 生产 Compose |
| `start.sh` | **本机**开发启动（vite 3270 + uvicorn 3275），非生产路径 |
| `docs/plans/AIDriveNote前端加载优化.md` | 前端性能优化说明 |

## 附加说明

- 仅当用户**明确要求**时才 `git commit` / `git push`
- 部署完成后告知用户访问 URL（`https://aiignite.com.cn/note/`），**不要**在回复中复述密码
- 更新部署 ≠ 备份数据库；需要备份时单独 `docker compose exec postgres pg_dump`
- 不要为了「确认部署环境」而向用户追问已在 `scripts/deploy.env` 中配置好的信息（HOST/USER/路径）
