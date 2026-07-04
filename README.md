# AIDriveNote

独立 AI 笔记应用：富文本 / Markdown / 思维导图 / 流程图，支持 Wiki 双向链接、全文搜索、版本历史、分享协作与 RAG 增强 AI 助手。

## 环境要求

- Python 3.12+
- Node.js 20+
- PostgreSQL 16+（本地 `localhost:5432`）
- Ollama（可选，AI 功能）

## 数据库初始化

```bash
psql -U postgres -c "CREATE DATABASE ai_drive_note;"
cd backend
cp .env.example .env   # 按需修改 DATABASE_URL
alembic upgrade head     # 或使用 create_all（main.py lifespan 也会建表）
```

## 本地开发

**一键启动（推荐）：**

```bash
./start.sh
```

- 前端：http://localhost:3270
- 后端：http://localhost:3275
- API 文档：http://localhost:3275/docs
- 日志目录：`.runtime-logs/`

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
| AI 设置 | `/settings/ai` | 默认模型、侧栏宽度 |
| 模型管理 | `/settings/ai/models` | 添加/编辑 Ollama 或云模型，测试连接 |
| 助手管理 | `/settings/ai/assistants` | 编辑「笔记助手」prompt/tools，管理技能绑定 |

侧栏 AI 按钮打开 AISidebar：可选助手、查看历史会话、SSE 流式对话；笔记页提供总结/续写/优化等快捷操作。写入类工具需经确认卡片后才落库。

## 测试

```bash
cd backend && AIDRIVE_TESTING=1 pytest --asyncio-mode=auto   # 24 passed
cd frontend && npm run build
```

## 生产部署

使用 `docker-compose.prod.yml`（backend + frontend + nginx，PostgreSQL 外置）：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## API 文档

开发环境：http://localhost:3275/docs

## 项目结构

```
AIDriveNote/
├── backend/     FastAPI + SQLAlchemy + Alembic
├── frontend/    React 19 + Vite + BlockNote
├── nginx/       生产反代配置
└── docs/plans/  设计方案
```
