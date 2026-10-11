---
name: aidrivenote-deploy
description: >-
  Deploy/publish AIDriveNote to the remote Ubuntu server <DEPLOY_HOST> via rsync +
  docker compose (deploy-remote.sh). Use when the user asks to 部署/发布/上线/deploy/
  publish/release/update AIDriveNote, or mentions the production host, port 3270,
  docker-compose.prod.yml, ~/AIDriveNote, aiignite.com.cn/note, or SSH to the server.
  Covers code-only frontend changes as well as full rebuilds with DB migrations.
---

# AIDriveNote 远程部署

将 AIDriveNote 从本地工作区发布到远程 Ubuntu 服务器（Docker Compose：postgres + backend + frontend + asr_gateway）。

## ⚠️ 先读这一条：不要在本机找部署线索

本机（Mac）**不运行**生产服务。首次接触时容易走错方向，请在动手前确认：

| 错误方向（本地） | 正确方向（远程） |
|------------------|------------------|
| `deploy.sh` 在本机跑 | `deploy.sh` **只在服务器**跑（`deploy-remote.sh` 会自动远程调用） |
| 本机 Docker daemon 跑生产 | 远程服务器 Docker |
| `start.sh`（本机 vite dev，端口 3270/3275） | 与生产部署**无关** |

**例外——根 `.env`**：本地仓库根目录的 `.env` 就是**生产配置源**（含子路径、SMTP、SSO 等），
`deploy-remote.sh` 的 rsync **会**用它覆盖服务器 `~/AIDriveNote/.env`（仅 `backend/.env` 被排除）。
因此：修改生产配置改本地 `.env`，不要直接在服务器上改；发布前脚本会自动做漂移预检（见下）。

- 一键脚本：[scripts/deploy-remote.sh](../../../scripts/deploy-remote.sh) — **默认就用它**
- 权威配置：[scripts/deploy.env](../../../scripts/deploy.env)（HOST/USER/PATH/子路径，已 gitignore）
- SSH **密钥已配置**（2026-10-11 验证，`ssh ubuntu@<DEPLOY_HOST>` 免密直连），无需 sshpass/askpass

## 发布脚本已内置的两道保险（2026-10-11 起）

1. **`.env` 漂移预检**：rsync 前对比本地与服务器的 `.env`（按"键名 + 值哈希"，只列键名不回显值），
   差异分三类提示：`值将覆盖` / `本地将新增` / `服务器键将丢失`。看到「服务器键将丢失」要停下来确认——
   那意味着服务器上有本地没有的配置，同步后会被删掉。
2. **子路径外网健康检查**：检查 `http://HOST:3270/note/health`（frontend nginx 将该路径代理到 backend
   `/health`），返回 `{"status":"ok","app":"AIDriveNote"}`。旧版脚本检查根 `/health`（子路径下恒 404），
   每次发布都报假警告，已修复。

## 环境事实（已验证）

- 生产站点部署在子路径 `/note/`，**不是**站点根目录。`/` 返回 301 属正常。
- 服务器：`<DEPLOY_HOST>`，用户 `ubuntu`，路径 `/home/ubuntu/AIDriveNote`（腾讯云新加坡）
  - ⚠️ 本文件与 `deploy.env.example` 一律用 `<DEPLOY_HOST>` 占位（仓库公开，不写真实 IP）；
    真实 HOST/USER/PATH 只存在于 gitignored 的 `scripts/deploy.env`，脚本会自动 source。
- 正式入口：`https://aiignite.com.cn/note/`；直连调试：`http://<DEPLOY_HOST>:3270/note/`
- 外网健康端点（子路径）：`https://aiignite.com.cn/note/health` → 真实 JSON
- 公网测试部署防护（2026-10 起）：`SELF_REGISTRATION_ENABLED=false`（自助注册关闭，账号由
  管理员在后台 `/admin` 创建）、`SSO_AUTO_CREATE_USERS=false`（portal 陌生账号不自动建号）、
  `USER_MAX_NOTES=100`（单用户笔记上限，含回收站）、`USER_MAX_UPLOAD_BYTES=2097152`
  （图片/附件 2MB）、`NOTE_MAX_RECORDING_BYTES=26214400`（录音 25MB，nginx 各层 26m 对齐）。
  这些键在 `docker-compose.prod.yml` 的 backend environment 中有同名安全默认值。
- 「发送到邮箱」功能仍依赖真实发信：服务器 `.env` 必须 `EMAIL_MOCK=false` 且配置
  `EMAIL_USER/EMAIL_PASS`（当前已满足）。若为 `true`，邮件只打印进后端日志。
- 数据库迁移随发布自动执行：`deploy.sh` 内部跑 `alembic upgrade head`（当前 head = `012_email_verification_codes`）。

## 只改了前端时的推荐范围

若本次改动只涉及前端（未改 `backend/`、未改数据库模型），**优先只重建 frontend**：

```bash
ssh ubuntu@<DEPLOY_HOST> "cd ~/AIDriveNote && docker compose -f docker-compose.prod.yml up -d --build frontend"
```

这样避免 `alembic upgrade head` 与 asr_gateway 镜像重建（后者构建期会下载 Whisper 权重，耗时较长）。
改动跨后端或涉及 schema 时才跑完整 `deploy.sh`（`deploy-remote.sh` 默认路径）。

## 发布前预检（本机）

```bash
cd backend && python -m pytest tests/ -q          # 全量约 20s，进程应干净退出
cd frontend && npm run build                      # 含 tsc --noEmit 类型检查
```

**含数据库迁移的发布**（本次改了模型/有新 alembic 版本）先备份数据库：

```bash
ssh ubuntu@<DEPLOY_HOST> "cd ~/AIDriveNote && docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U postgres ai_drive_note" > backup_$(date +%F-%H%M).sql
```

## Agent 执行清单

```
部署进度：
- [ ] 1. 确认目标（远程服务器，不是本机）与改动范围（仅前端 or 全量）
- [ ] 2. 本地预检：pytest 全量 + npm run build；含迁移则先 pg_dump 备份
- [ ] 3. ./scripts/deploy-remote.sh（内置 .env 漂移预检 → rsync → 远程 deploy.sh → 外网健康检查）
- [ ] 4. 确认漂移预检输出（「服务器键将丢失」必须人工确认）
- [ ] 5. 确认迁移已应用（如本次含迁移）：ssh 查 alembic current = head
- [ ] 6. 验证产物确实含本次改动（grep 标识字符串，见 Step 4）
- [ ] 7. 功能冒烟（关键流程 curl 或浏览器实测），测试数据用后即清
- [ ] 8. 汇报 URL 与结果
```

**禁止**将 SSH 密码、`.env` 密钥写入 git 或 skill 文件。凭据只来自 `deploy.env` 或环境变量。
**发布用的是整个工作区**（rsync），与 git 是否提交无关；但发布后建议按功能拆分提交。

## 快速部署

```bash
./scripts/deploy-remote.sh
```

内部流程：`.env` 漂移预检 → rsync 同步（排除 node_modules/.git/backend/.env/dist 等）→
远程 `chmod +x deploy.sh && ./deploy.sh`（compose up -d --build → alembic upgrade head → 服务器本机
health 检查）→ 外网 `${VITE_BASE_PATH%/}/health` JSON 检查 + 前端 200 检查。

## 分步手动部署（一键脚本失败时）

### Step 1 — 同步代码

```bash
set -a && source scripts/deploy.env && set +a
rsync -avz \
  --exclude 'node_modules' --exclude '.venv' --exclude '__pycache__' \
  --exclude '.runtime-logs' --exclude 'backend/.env' --exclude '.git' \
  --exclude 'frontend/dist' --exclude 'backend/.pytest_cache' \
  --exclude 'scripts/deploy.env' \
  -e "ssh -o StrictHostKeyChecking=no" \
  ./ "$AIDRIVENOTE_DEPLOY_USER@$AIDRIVENOTE_DEPLOY_HOST:$AIDRIVENOTE_DEPLOY_PATH/"
```

注意：根 `.env` **不在**排除列表（本地为配置源，有意同步）；`backend/.env` 被排除（服务器侧独立保留）。

### Step 2 — 远程构建与启动

```bash
ssh ubuntu@<DEPLOY_HOST> "cd ~/AIDriveNote && chmod +x deploy.sh && ./deploy.sh"
```

### Step 3 — 确认迁移（含 schema 变更时）

```bash
ssh ubuntu@<DEPLOY_HOST> "cd ~/AIDriveNote && docker compose -f docker-compose.prod.yml exec -T postgres psql -U postgres -d ai_drive_note -c 'SELECT version_num FROM alembic_version;'"
```

### Step 4 — 验证产物确实含本次改动（关键）

**只看 HTTP 200 不够** —— 旧产物同样返回 200。用「标识字符串」确认新代码已上线。

无需登服务器的本机验证法（首选）：

```bash
HTML=$(curl -s https://aiignite.com.cn/note/)
JS=$(echo "$HTML" | grep -o '/note/assets/index-[^"]*\.js' | head -1)
curl -s "https://aiignite.com.cn$JS" | grep -c '<本次改动的代码标识串>'
```

或登服务器 grep 容器内产物（中文标识串 terser 会剥注释，只能 grep 代码/字符串字面量）：

```bash
ssh ubuntu@<DEPLOY_HOST> "docker exec aidrivenote-frontend-1 sh -c \
  'grep -o \".\{130\}<标识串>\" /usr/share/nginx/html/assets/<Chunk>-*.js'"
```

### Step 5 — 外网验证与功能冒烟

```bash
# 正式入口（HTTP/2 + gzip，性能验收以此为准）
curl -s https://aiignite.com.cn/note/health
curl -sI -H "Accept-Encoding: gzip" "https://aiignite.com.cn/note/" | grep -iE "content-encoding|http/"

# 功能冒烟示例（注册发码链路；对已注册邮箱应返回 409）
curl -s -X POST https://aiignite.com.cn/note/api/v1/auth/register/request \
  -H 'Content-Type: application/json' -d '{"email":"<已注册邮箱>","name":"probe"}' -w " [%{http_code}]"
```

> **子路径陷阱**：`https://aiignite.com.cn/health`（不带 /note）不存在；`/` 301 是正常的。
> 真实健康端点带前缀：`/note/health` 返回 JSON。SPA 深链（如 `/note/settings`）返回 200 + HTML 属正常，
> 但那只能证明前端在服务，不能证明 API 健康——判断 API 一律用 `/note/health` 的 JSON。
>
> `POST /api/v1/ai/chat/stream`（SSE）所在 location 有意关闭 `proxy_buffering`，该端点不压缩，属预期。

需要真实浏览器验证（如富文本粘贴图片）时：在服务器生产库插一个临时测试账号（bcrypt 密码哈希本机生成、
注意 `is_deleted` 列需显式给 false），浏览器跑完用例后**删除该账号及其全部数据**（笔记、验证码、上传资产）。

## 首次部署（服务器尚无项目）

完整步骤见 [reference.md](reference.md#首次部署)。摘要：

1. SSH 登录 Ubuntu，确认 Docker 已安装
2. 确认**本地**根 `.env` 即生产配置（rsync 自动同步到服务器；`DATABASE_URL` 主机名用 `postgres`）
3. 腾讯云/安全组放行 **TCP 3270**（宿主机 iptables 不够，需云控制台入站规则）
4. 执行 `./scripts/deploy-remote.sh`

### 根 `.env` 必备项（本地编辑，同步上线）

```bash
DATABASE_URL=postgresql+asyncpg://postgres:<PASSWORD>@postgres:5432/ai_drive_note
DATABASE_URL_SYNC=postgresql://postgres:<PASSWORD>@postgres:5432/ai_drive_note
SECRET_KEY=<随机64hex>
POSTGRES_PASSWORD=<与上面一致>
CORS_ORIGINS=https://aiignite.com.cn,https://www.aiignite.com.cn
VITE_BASE_PATH=/note/  VITE_API_URL=/note/api/v1  NGINX_SUBPATH=1  APP_HEALTH_PATH=/note/health
# 注册验证码真实发信（EMAIL_MOCK=false 才会真发，true 只进日志）
EMAIL_HOST=smtp.qq.com  EMAIL_PORT=465  EMAIL_USER=...  EMAIL_PASS=...  EMAIL_MOCK=false
NOTE_ASR_REMOTE_API_KEY=<asr_gateway 必填>
# 公网测试部署防护（关闭注册 / SSO 不自动建号 / 单用户配额与 2MB 上传上限）
SELF_REGISTRATION_ENABLED=false  SSO_AUTO_CREATE_USERS=false
USER_MAX_NOTES=100  USER_MAX_UPLOAD_BYTES=2097152  NOTE_MAX_RECORDING_BYTES=26214400
```

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 本机没有 Docker / 服务起不来 | **找错机器了** | 本机不跑生产。用 `scripts/deploy-remote.sh` 推送到远程 |
| `/` 301、不带 `/note` 的 `/health` 404 | 子路径部署，**正常** | 健康检查用 `/note/health`（返回 JSON） |
| 发布后页面没变化 | 旧产物同样 200 | 按 Step 4 grep 标识串确认；必要时强刷（Service Worker 需更新） |
| 外网 `:3270` 超时 | 云安全组未放行 | 控制台添加入站 TCP 3270 |
| `alembic` 报表已存在 | 曾用 create_all 建表 | `docker compose exec -T backend alembic stamp head` |
| 注册接口 502 | SMTP 发信失败 | 自助注册已默认关闭（403）。若临时开放仍 502：查服务器 `.env` 的 `EMAIL_USER/EMAIL_PASS`、`EMAIL_MOCK=false`；看 backend 日志 |
| 上传图片报「图片过大」 | `USER_MAX_UPLOAD_BYTES=2MB` | 按设计限制；nginx 各层 `client_max_body_size 26m` 仅为录音预留，勿随意调大 |
| `start.sh` 在 `/bin/ps` 处中断 | 沙箱禁止 `/bin/ps` | 与部署无关；本机开发手动起 uvicorn + vite |
| API 401 | 未登录 | 正常鉴权行为 |

## 相关文件

| 路径 | 用途 |
|------|------|
| `scripts/deploy-remote.sh` | 本地一键发布（.env 漂移预检 + rsync + 远程 deploy.sh + 外网检查） |
| `scripts/deploy.env` | 实际部署配置（gitignored，勿提交/勿外传） |
| `scripts/deploy.env.example` | 部署配置模板 |
| `deploy.sh` | 服务器端构建/迁移/检查 |
| `docker-compose.prod.yml` | 生产 Compose |
| `start.sh` | **本机**开发启动（vite 3270 + uvicorn 3275），非生产路径 |
| `docs/plans/AIDriveNote前端加载优化.md` | 前端性能优化说明 |

## 附加说明

- 仅当用户**明确要求**时才 `git commit` / `git push`
- 部署完成后告知用户访问 URL（`https://aiignite.com.cn/note/`），**不要**在回复中复述密码
- 更新部署 ≠ 备份数据库；含迁移的发布前先 pg_dump（见「发布前预检」）
- 不要为了「确认部署环境」而向用户追问已在 `scripts/deploy.env` 中配置好的信息（HOST/USER/路径）
