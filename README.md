# AIDriveNote

独立 AI 笔记应用：富文本 / Markdown / 思维导图 / 流程图，支持 Wiki 双向链接、全文搜索、版本历史、分享协作与 RAG 增强 AI 助手。

从 AIIgnite PLM NOTE 模块独立拆分，可单独部署运行。

## 功能概览

| 类别 | 能力 |
|------|------|
| 笔记类型 | 富文本（BlockNote）、Markdown（GFM / 数学公式 / 代码高亮）、思维导图、流程图（Draw.io） |
| 组织 | 文件夹树、标签、置顶 / 收藏、模板库、回收站 |
| 知识链接 | `[[Wiki 链接]]`、反向引用面板 |
| 搜索 | PostgreSQL 全文检索（TSVECTOR） |
| 协作 | 笔记分享（view / edit 权限）、用户搜索 |
| 版本 | 自动保存修订、历史列表、一键恢复 |
| 导出 | 富文本/Markdown → PDF / DOCX / HTML / MD；导图 → PDF / PNG / JSON；流程图 → PDF / PNG / SVG |
| AI | 侧栏对话（SSE 流式）、笔记页快捷操作（总结 / 续写 / 优化）、RAG 检索、12 个笔记工具、写入需确认 |
| 界面 | 深色 / 浅色主题、全屏编辑、`Ctrl/Cmd+N` 新建、`Ctrl/Cmd+Shift+F` 聚焦搜索 |

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Python 3.12 · FastAPI · SQLAlchemy 2（async）· Alembic · JWT |
| 前端 | React 19 · Vite 6 · TypeScript · Tailwind CSS 4 · React Router 7 |
| 编辑器 | BlockNote · @uiw/react-md-editor · simple-mind-map · Draw.io embed |
| 数据库 | PostgreSQL 16+ |
| AI | Ollama（默认）· OpenAI · Anthropic · MiniMax · LM Studio（OpenAI 兼容） |

## 环境要求

- Python 3.12+
- Node.js 20+
- PostgreSQL 16+（本地 `localhost:5432`）
- Ollama（可选，AI 功能；默认 `http://localhost:11434`）

## 数据库初始化

```bash
psql -U postgres -c "CREATE DATABASE ai_drive_note;"
cd backend
cp .env.example .env   # 按需修改 DATABASE_URL、SECRET_KEY
alembic upgrade head     # 或依赖 main.py lifespan 自动建表
```

## 本地开发

**一键启动（推荐）：**

```bash
./start.sh
```

| 服务 | 地址 |
|------|------|
| 前端 | http://localhost:3270 |
| 后端 | http://localhost:3275 |
| API 文档 | http://localhost:3275/docs |
| 日志 | `.runtime-logs/` |

`start.sh` 会自动检测端口占用、从 `.env.example` 复制配置、等待健康检查就绪。首次运行请确保 PostgreSQL 已创建数据库并执行迁移。

**手动启动：**

```bash
# 后端 :3275
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 3275

# 前端 :3270
cd frontend
npm install
npm run dev
```

浏览器打开 http://localhost:3270 ，注册账号后使用。

## AI 助手配置

启动 Ollama 后，可在应用内配置 AI（无需改 `.env` 即可使用默认 Ollama 模型）：

| 页面 | 路径 | 功能 |
|------|------|------|
| AI 设置 | `/settings/ai` | 默认跳转模型管理 |
| 模型管理 | `/settings/ai/models` | 添加 / 编辑 Ollama 或云模型，测试连接 |
| 助手管理 | `/settings/ai/assistants` | 编辑「笔记助手」prompt / tools，克隆助手 |
| 技能管理 | `/settings/ai/skills` | 管理技能及页面 / 助手绑定 |

侧栏 AI 按钮打开 AISidebar：可选助手、查看历史会话、SSE 流式对话；笔记页提供总结 / 续写 / 优化等快捷操作。写入类工具需经确认卡片后才落库。

内置 5 个技能：读取并总结、续写、优化润色、创建笔记、扩展导图。RAG 通过全文检索注入 Top-5 相关笔记上下文。

## 测试

```bash
cd backend && AIDRIVE_TESTING=1 pytest --asyncio-mode=auto   # 31 passed
cd frontend && npm run build                                 # tsc + vite build
cd frontend && npm run type-check
```

## 生产部署

`docker-compose.prod.yml` 包含 PostgreSQL 16、backend、frontend（nginx 反代）三服务：

```bash
# 1. 配置根目录 .env（参考 backend/.env.example，额外需要 POSTGRES_PASSWORD）
cp backend/.env.example .env
# 编辑 .env：POSTGRES_PASSWORD、DATABASE_URL、SECRET_KEY 等

# 2. 构建并启动
docker compose -f docker-compose.prod.yml up -d --build

# 3. 数据库迁移
docker compose -f docker-compose.prod.yml exec backend alembic upgrade head
```

或使用服务器端脚本（需先 rsync 代码到服务器）：

```bash
./deploy.sh                              # 服务器 ~/AIDriveNote 目录执行
./scripts/deploy-remote.sh               # 本地一键 rsync + 远程 deploy
```

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端 | 3270 | 对外访问入口，nginx 反代 `/api/` |
| 后端 | 127.0.0.1:3275 | 仅本机，不对外暴露 |
| PostgreSQL | 内部 | 数据卷 `postgres_data` |

也可省略 compose 中的 postgres 服务，将 `DATABASE_URL` 指向外置 PostgreSQL。

## API 文档

开发环境：http://localhost:3275/docs

主要路由前缀 `/api/v1`：

- `/auth` — 注册、登录、刷新、当前用户
- `/users/search` — 分享时搜索用户
- `/notes` — 笔记 CRUD、文件夹、标签、模板、全文搜索、版本、分享等
- `/ai` — 模型 / 助手 / 技能 / 会话 / SSE 流式对话

健康检查：`GET /health` → `{ "status": "ok", "app": "AIDriveNote" }`

## 项目结构

```
AIDriveNote/
├── backend/           FastAPI + SQLAlchemy + Alembic
│   ├── app/routers/   auth、users、note、ai
│   ├── app/services/  note、ai、ai_providers、ai_skills
│   └── app/ai_tools/  12 个笔记管理工具
├── frontend/          React 19 + Vite + 多编辑器
│   └── nginx.conf     生产容器内反代配置
├── nginx/             独立 nginx 配置（可选）
├── scripts/           deploy-remote.sh、deploy.env.example
├── docs/plans/        设计方案与实施记录
├── start.sh           本地一键启动
└── deploy.sh          生产部署脚本
```

## 路线图

- pgvector 语义搜索
- 知识图谱 UI
- Slash 行内 AI

详见 `docs/plans/`。
